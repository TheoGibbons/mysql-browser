/**
 * One worker thread per open connection tab.
 *
 * Everything expensive — socket reads, packet parsing, row materialisation —
 * happens here, so a slow query in one connection tab can never stall the UI or
 * another tab's query. Inside a worker each *query tab* additionally gets its
 * own server connection, so two tabs of the same connection also run in
 * parallel.
 *
 * This file is engine-neutral: it owns the tunnel, the IAM token, the pool of
 * per-tab connections, keep-alive, dead-socket eviction and the retry rules.
 * Everything MySQL- or Postgres-specific sits behind `Driver` (see ./driver).
 */

import { parentPort, workerData } from 'node:worker_threads'
import type {
  ConnectionConfig,
  Preferences,
  QueryOutcome,
  ResultSet,
  SchemaInfo,
  TableDefinition
} from '@shared/types'
import { engineOf } from '@shared/types'
import type { WorkerEvent, WorkerInit, WorkerRequest, WorkerResponse } from '@shared/worker-protocol'
import { splitStatements, isReadOnlyStatement } from '@shared/sql'
import { openTunnel, type Tunnel } from './tunnel'
import { IamTokenProvider } from './iam'
import { resolveEditTarget, type Driver, type DriverConnection, type DriverContext } from './driver'
import { MysqlDriver } from './drivers/mysql'
import { PostgresDriver } from './drivers/postgres'

const port = parentPort
if (!port) throw new Error('db worker must be started as a worker thread')

const init = workerData as WorkerInit
const config: ConnectionConfig = init.config
let prefs: Preferences = init.prefs
const engine = engineOf(config)

/** Hard cap so a runaway `SELECT *` cannot exhaust memory. */
const MAX_ROWS = 500_000

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

interface TabConnection {
  conn: DriverConnection
  busy: boolean
  lastUsed: number
  /** Set the moment the socket errors or ends — a dead connection never recovers. */
  dead: boolean
}

let tunnel: Tunnel | null = null
let iam: IamTokenProvider | null = null
/** Metadata + cancel connection, kept free of user queries so cancel always works. */
let control: DriverConnection | null = null
let controlDead = false
let controlReopen: Promise<void> | null = null
let serverVersion = 'unknown'
const tabConnections = new Map<string, TabConnection>()
/** Follows the last successful `USE` / `SET search_path`. */
let currentSchema: string | undefined = config.defaultSchema || undefined
let keepAliveTimer: NodeJS.Timeout | null = null
let closed = false

function emit(event: WorkerEvent): void {
  port!.postMessage(event)
}

const context: DriverContext = {
  config,
  get prefs() {
    return prefs
  },
  tunnel: () => tunnel,
  currentSchema: () => currentSchema,
  async password() {
    if (config.method === 'iam') {
      if (!iam) {
        iam = new IamTokenProvider(config.iamTokenCommand || '', (message) =>
          emit({ event: 'log', level: 'warn', message })
        )
        iam.startBackgroundRefresh()
      }
      return iam.get()
    }
    return config.password
  },
  async refreshPassword() {
    if (config.method !== 'iam' || !iam) return false
    try {
      await iam.get(true)
      return true
    } catch {
      return false
    }
  },
  log: (level, message) => emit({ event: 'log', level, message })
}

const driver: Driver = engine === 'postgres' ? new PostgresDriver(context) : new MysqlDriver(context)

/** Throws the connection away without waiting for a clean goodbye. */
function discard(conn: DriverConnection | null): void {
  if (!conn) return
  try {
    conn.destroy()
  } catch {
    /* already gone */
  }
}

async function openControl(): Promise<DriverConnection> {
  const conn = await driver.open(() => {
    if (control === conn) controlDead = true
  })
  control = conn
  controlDead = false
  return conn
}

/**
 * Replaces a control connection whose socket has gone. Concurrent callers share
 * one attempt so a burst of metadata requests cannot open a burst of sockets.
 */
function reopenControl(): Promise<void> {
  if (controlReopen) return controlReopen

  controlReopen = (async () => {
    const previous = control
    control = null
    discard(previous)
    emit({ event: 'log', level: 'warn', message: 'Connection was dropped — reopening.' })
    emit({ event: 'status', status: 'connecting' })
    try {
      await openControl()
    } catch (err) {
      // Leaves the session in `error`, which is what makes the renderer offer
      // (and auto-trigger) a full Reconnect — the only way to rebuild an SSH
      // tunnel or re-run the IAM token command from scratch.
      emit({ event: 'status', status: 'error', message: (err as Error).message })
      throw err
    }
    emit({ event: 'status', status: 'connected', serverVersion })
    emit({ event: 'log', level: 'info', message: 'Connection reopened.' })
  })().finally(() => {
    controlReopen = null
  })

  return controlReopen
}

async function connect(): Promise<{ serverVersion: string }> {
  emit({ event: 'status', status: 'connecting' })

  if (config.method === 'ssh') {
    tunnel = await openTunnel(config, Math.max(1, prefs.connectTimeoutSec) * 1000)
  }

  const conn = await openControl()
  serverVersion = await driver.serverVersion(conn)

  startKeepAlive()
  emit({ event: 'status', status: 'connected', serverVersion })
  return { serverVersion }
}

async function disconnect(): Promise<void> {
  closed = true
  stopKeepAlive()
  iam?.stop()

  const all = [...tabConnections.values()].map((tc) => tc.conn)
  tabConnections.clear()
  if (control) all.push(control)
  control = null
  controlDead = false

  await Promise.all(
    all.map((c) =>
      c.end().catch(() => {
        try {
          c.destroy()
        } catch {
          /* already gone */
        }
      })
    )
  )

  tunnel?.close()
  tunnel = null
  emit({ event: 'status', status: 'offline' })
}

function startKeepAlive(): void {
  stopKeepAlive()
  const seconds = prefs.keepAliveIntervalSec
  if (!seconds || seconds <= 0) return
  keepAliveTimer = setInterval(() => {
    void pingAll()
  }, seconds * 1000)
  keepAliveTimer.unref?.()
}

function stopKeepAlive(): void {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer)
    keepAliveTimer = null
  }
}

/**
 * Keeps sockets warm and, more importantly, evicts the ones that died while
 * idle. A dead tab connection that stays in the map answers every later query
 * with a connection-closed error; dropping it here means the next query
 * silently opens a fresh one.
 */
async function pingAll(): Promise<void> {
  if (closed) return

  await Promise.all(
    [...tabConnections].map(async ([tabId, tc]) => {
      if (tc.busy) return
      const alive =
        !tc.dead && tc.conn.isUsable() && (await tc.conn.ping().then(() => true, () => false))
      if (alive) return
      tc.dead = true
      if (tabConnections.get(tabId) === tc) tabConnections.delete(tabId)
      discard(tc.conn)
    })
  )

  if (!control || closed) return
  const controlAlive =
    !controlDead && control.isUsable() && (await control.ping().then(() => true, () => false))
  if (controlAlive) return

  try {
    await reopenControl()
  } catch (err) {
    emit({ event: 'status', status: 'error', message: (err as Error).message })
  }
}

async function connectionForTab(tabId: string): Promise<TabConnection> {
  const existing = tabConnections.get(tabId)
  if (existing && !existing.dead && existing.conn.isUsable()) return existing
  if (existing) {
    // The cached socket is gone and cannot be revived, so throw it away rather
    // than let it reject every future query on this tab.
    tabConnections.delete(tabId)
    discard(existing.conn)
  }

  const entry: TabConnection = {
    conn: null as unknown as DriverConnection,
    busy: false,
    lastUsed: Date.now(),
    dead: false
  }
  entry.conn = await driver.open(() => {
    entry.dead = true
  })
  tabConnections.set(tabId, entry)
  return entry
}

/** Swaps a tab's dead connection for a fresh one, preserving the busy marker. */
async function replaceTabConnection(tabId: string, previous: TabConnection): Promise<TabConnection> {
  previous.dead = true
  previous.busy = false
  if (tabConnections.get(tabId) === previous) tabConnections.delete(tabId)
  discard(previous.conn)
  emit({ event: 'log', level: 'warn', message: 'Query connection was dropped — reconnecting.' })

  const entry = await connectionForTab(tabId)
  entry.busy = true
  return entry
}

/**
 * Whether a failed statement can safely be re-run on a fresh connection.
 *
 * An enqueue refusal proves the packet never left the client, so anything can be
 * retried. When the socket died mid-flight we cannot tell whether the server
 * applied the statement, so only reads — which have no side effects — go again.
 */
function canRetryStatement(err: unknown, sql: string): boolean {
  if (!driver.isConnectionLost(err)) return false
  return driver.isEnqueueRefusal(err) || isReadOnlyStatement(sql)
}

// ---------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------

async function runStatement(
  entry: TabConnection,
  sql: string,
  limitRows: number
): Promise<ResultSet> {
  const started = process.hrtime.bigint()
  const raw = await entry.conn.query(sql)
  const executed = process.hrtime.bigint()
  const durationMs = Number(executed - started) / 1e6

  if (!raw.hasResultSet) {
    return {
      columns: [],
      rows: [],
      message: `${raw.affectedRows} row(s) affected`,
      affectedRows: raw.affectedRows,
      durationMs,
      fetchMs: 0,
      editSchema: null,
      editTable: null,
      keyColumns: [],
      truncated: false
    }
  }

  const cap = Math.min(limitRows || MAX_ROWS, MAX_ROWS)
  const truncated = raw.rows.length > cap
  const data = truncated ? raw.rows.slice(0, cap) : raw.rows
  const fetchMs = Number(process.hrtime.bigint() - executed) / 1e6
  const target = resolveEditTarget(raw.columns)

  return {
    columns: raw.columns,
    rows: data,
    message: truncated
      ? `${data.length} row(s) returned (truncated at ${cap})`
      : `${data.length} row(s) returned`,
    affectedRows: 0,
    durationMs,
    fetchMs,
    editSchema: target.schema,
    editTable: target.table,
    keyColumns: target.keyColumns,
    truncated
  }
}

/** Cancels a tab's in-flight query from the control connection. */
async function cancelTab(tabId: string): Promise<{ killed: boolean }> {
  const entry = tabConnections.get(tabId)
  if (!entry || !entry.busy || !control) return { killed: false }
  try {
    // Cancelling is best-effort, but it must not fail merely because the control
    // socket went idle-dead while the user's query was still running.
    await withControl((c) => driver.cancel(c, entry.conn.backendId))
    return { killed: true }
  } catch {
    return { killed: false }
  }
}

async function runQuery(tabId: string, sql: string, limitRows?: number): Promise<QueryOutcome> {
  const statements = splitStatements(sql, engine)
  if (statements.length === 0) throw new Error('Nothing to execute')

  let entry = await connectionForTab(tabId)
  if (entry.busy) throw new Error('This tab already has a query running')

  entry.busy = true
  const results: ResultSet[] = []
  const executed: string[] = []

  // Read timeout is enforced client-side: neither driver has a per-query
  // timeout, so we cancel the query from the control connection instead.
  let timedOut = false
  const readTimeout = prefs.readTimeoutSec > 0 ? prefs.readTimeoutSec * 1000 : 0
  let timer: NodeJS.Timeout | null = null
  if (readTimeout > 0) {
    timer = setTimeout(() => {
      timedOut = true
      void cancelTab(tabId)
    }, readTimeout)
  }

  try {
    for (const statement of statements) {
      let result: ResultSet
      try {
        result = await runStatement(entry, statement.text, limitRows ?? MAX_ROWS)
      } catch (err) {
        // An idle socket dropped by RDS/a NAT gateway looks exactly like this,
        // and the user should never have to press Reconnect for it.
        if (timedOut || closed || !canRetryStatement(err, statement.text)) throw err
        entry = await replaceTabConnection(tabId, entry)
        result = await runStatement(entry, statement.text, limitRows ?? MAX_ROWS)
      }
      results.push(result)
      executed.push(statement.text)

      // Track the schema switch so new tab connections start in the same place.
      const schema = driver.schemaFromStatement(statement.text)
      if (schema) currentSchema = schema
    }
    return { results, statements: executed }
  } catch (err) {
    if (timedOut) {
      throw new Error(
        `Query exceeded the ${prefs.readTimeoutSec}s read timeout and was cancelled. ` +
          `Raise "DBMS connection read timeout interval" in Preferences to allow longer queries.`
      )
    }
    throw err
  } finally {
    if (timer) clearTimeout(timer)
    entry.busy = false
    entry.lastUsed = Date.now()
  }
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/**
 * Runs metadata work on the control connection, reopening it first when the
 * socket has died and retrying once if it dies mid-flight. Every caller is a
 * read, so re-running is always safe.
 */
async function withControl<T>(run: (conn: DriverConnection) => Promise<T>): Promise<T> {
  if (!control) throw new Error('Not connected')
  if (controlDead || !control.isUsable()) await reopenControl()

  try {
    return await run(control!)
  } catch (err) {
    if (closed || !driver.isConnectionLost(err)) throw err
    await reopenControl()
    return run(control!)
  }
}

async function testConnection(): Promise<{ serverVersion: string; latencyMs: number }> {
  const started = Date.now()
  let temporaryTunnel = false
  try {
    if (config.method === 'ssh' && !tunnel) {
      tunnel = await openTunnel(config, Math.max(1, prefs.connectTimeoutSec) * 1000)
      temporaryTunnel = true
    }
    const conn = await driver.open()
    try {
      const version = await driver.serverVersion(conn)
      return { serverVersion: version, latencyMs: Date.now() - started }
    } finally {
      await conn.end().catch(() => undefined)
    }
  } finally {
    if (temporaryTunnel && tunnel) {
      tunnel.close()
      tunnel = null
    }
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function handle(req: WorkerRequest): Promise<unknown> {
  switch (req.type) {
    case 'connect':
      return connect()
    case 'disconnect':
      return disconnect()
    case 'test':
      return testConnection()
    case 'query':
      return runQuery(req.tabId, req.sql, req.limitRows)
    case 'cancel':
      return cancelTab(req.tabId)
    case 'listSchemas':
      return withControl((c): Promise<SchemaInfo[]> => driver.listSchemas(c))
    case 'tableDefinition':
      return withControl((c): Promise<TableDefinition> =>
        driver.tableDefinition(c, req.schema, req.table)
      )
    case 'tableColumns':
      return withControl((c) => driver.tableColumns(c, req.schema, req.table))
    case 'schemaColumns':
      return withControl((c) => driver.schemaColumns(c, req.schema))
    case 'createStatement':
      return withControl((c) => driver.createStatement(c, req.kind, req.schema, req.table))
    case 'charsets':
      return withControl((c) => driver.charsets(c))
    case 'setPrefs':
      prefs = req.prefs
      startKeepAlive()
      return undefined
    default: {
      const exhaustive: never = req
      throw new Error(`Unknown request ${JSON.stringify(exhaustive)}`)
    }
  }
}

port.on('message', (req: WorkerRequest) => {
  handle(req)
    .then((result) => {
      const response: WorkerResponse = { id: req.id, ok: true, result }
      port.postMessage(response)
    })
    .catch((err: any) => {
      const response: WorkerResponse = {
        id: req.id,
        ok: false,
        error: {
          message: err?.sqlMessage || err?.message || String(err),
          code: err?.code,
          errno: err?.errno,
          sqlState: err?.sqlState
        }
      }
      port.postMessage(response)
    })
})

process.on('uncaughtException', (err) => {
  if (closed) return
  emit({ event: 'status', status: 'error', message: err.message })
})
