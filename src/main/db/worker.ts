/**
 * One worker thread per open connection tab.
 *
 * Everything expensive — socket reads, packet parsing, row materialisation —
 * happens here, so a slow query in one connection tab can never stall the UI or
 * another tab's query. Inside a worker each *query tab* additionally gets its
 * own MySQL connection, so two tabs of the same connection also run in parallel.
 */

import { parentPort, workerData } from 'node:worker_threads'
import mysql from 'mysql2/promise'
import type { Connection, ConnectionOptions, FieldPacket } from 'mysql2/promise'
import type {
  CellValue,
  ColumnMeta,
  ConnectionConfig,
  ForeignKeyInfo,
  IndexInfo,
  Preferences,
  QueryOutcome,
  ResultSet,
  SchemaInfo,
  TableDefinition
} from '@shared/types'
import type { WorkerEvent, WorkerInit, WorkerRequest, WorkerResponse } from '@shared/worker-protocol'
import { splitStatements, firstKeyword, isReadOnlyStatement } from '@shared/sql'
import { openTunnel, type Tunnel } from './tunnel'
import { IamTokenProvider } from './iam'
import {
  BINARY_CHARSET,
  FLAG_AUTO_INCREMENT,
  FLAG_NOT_NULL,
  FLAG_PRI_KEY,
  isNumericType,
  typeNameWithFlags
} from './types'

const port = parentPort
if (!port) throw new Error('db worker must be started as a worker thread')

const init = workerData as WorkerInit
let config: ConnectionConfig = init.config
let prefs: Preferences = init.prefs

/** Hard cap so a runaway `SELECT *` cannot exhaust memory. */
const MAX_ROWS = 500_000
/** Blobs larger than this are summarised rather than hex-dumped into the grid. */
const MAX_INLINE_BLOB = 256

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

interface TabConnection {
  conn: Connection
  threadId: number
  busy: boolean
  lastUsed: number
  /** Set the moment the socket errors or ends — a dead mysql2 connection never recovers. */
  dead: boolean
}

let tunnel: Tunnel | null = null
let iam: IamTokenProvider | null = null
/** Metadata + KILL connection, kept free of user queries so cancel always works. */
let control: Connection | null = null
let controlDead = false
let controlReopen: Promise<void> | null = null
let serverVersion = 'unknown'
const tabConnections = new Map<string, TabConnection>()
/** Follows the last successful `USE`, so new tab connections open in the same schema. */
let currentSchema: string | undefined = config.defaultSchema || undefined
let keepAliveTimer: NodeJS.Timeout | null = null
let closed = false

function emit(event: WorkerEvent): void {
  port!.postMessage(event)
}

async function resolvePassword(): Promise<string | undefined> {
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
}

async function buildOptions(): Promise<ConnectionOptions> {
  const password = await resolvePassword()
  const host = tunnel ? '127.0.0.1' : config.host || '127.0.0.1'
  const portNumber = tunnel ? tunnel.localPort : config.port || 3306
  const isIam = config.method === 'iam'

  const options: ConnectionOptions = {
    host,
    port: portNumber,
    user: config.user,
    password,
    database: currentSchema || undefined,
    connectTimeout: Math.max(1, prefs.connectTimeoutSec) * 1000,
    // Arrays are ~3x cheaper than objects for wide result sets and map directly
    // onto the grid's column-indexed model.
    rowsAsArray: true,
    // Keep temporal and high-precision values exactly as the server sent them.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
    charset: 'utf8mb4_general_ci',
    typeCast: castField
  }

  if (isIam) {
    // An RDS IAM user is created WITH AWSAuthenticationPlugin, and the server
    // asks such clients for `mysql_clear_password` — the token is the password,
    // sent as-is. mysql2 refuses that plugin unless it is enabled explicitly,
    // and RDS only accepts a token over TLS, so both are non-negotiable here.
    options.enableCleartextPlugin = true
  }

  if (config.useSSL || isIam) {
    // RDS presents an Amazon CA that is not in Node's trust store, so IAM
    // connections only verify when the user has asked for it deliberately.
    options.ssl = {
      rejectUnauthorized: config.useSSL ? config.rejectUnauthorized !== false : false
    }
  }

  return options
}

/** Converts binary payloads into something the grid can display. */
function castField(field: any, next: () => unknown): unknown {
  const type: string = field.type
  if (type === 'GEOMETRY') {
    const buf = field.buffer()
    return buf === null ? null : `GEOMETRY (${buf.length} bytes)`
  }
  if (type === 'BLOB' || type === 'TINY_BLOB' || type === 'MEDIUM_BLOB' || type === 'LONG_BLOB') {
    const isBinary = field.characterSet === BINARY_CHARSET
    if (!isBinary) return field.string()
    const buf = field.buffer()
    if (buf === null) return null
    return buf.length <= MAX_INLINE_BLOB
      ? '0x' + buf.toString('hex')
      : `BLOB (${buf.length} bytes)`
  }
  if (type === 'BIT') {
    const buf = field.buffer()
    if (buf === null) return null
    let value = 0n
    for (const byte of buf) value = (value << 8n) | BigInt(byte)
    return value.toString()
  }
  return next()
}

/**
 * RDS answers every IAM misconfiguration with a bare "Access denied", so spell
 * out what is left to check once the token itself has been generated.
 */
function decorateError(err: any): any {
  if (config.method !== 'iam' || err?.code !== 'ER_ACCESS_DENIED_ERROR') return err
  const message =
    `${err.sqlMessage || err.message}\n\n` +
    'The token command succeeded, so the database rejected the token itself. Check that ' +
    "the MySQL user was created WITH AWSAuthenticationPlugin AS 'RDS', that the IAM identity " +
    'the token was signed with is allowed rds-db:connect for that user, and that --username in ' +
    'the token command matches the username above exactly (it is case-sensitive).'
  err.message = message
  err.sqlMessage = message
  return err
}

/**
 * Network-level failures that mean "this socket is gone", as opposed to a SQL
 * error the server deliberately returned. Anything matched here is recoverable
 * by throwing the connection away and opening a new one.
 */
const LOST_CONNECTION_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ESOCKET',
  'EHOSTUNREACH',
  'ENETRESET',
  'ER_CLIENT_INTERACTION_TIMEOUT'
])

function isConnectionLost(err: any): boolean {
  if (!err) return false
  if (err.code && LOST_CONNECTION_CODES.has(err.code)) return true
  const message = String(err.sqlMessage || err.message || '')
  return (
    // Raised by mysql2 when a command is queued after the socket died. The
    // packet never leaves the client, so the statement provably did not run.
    message.includes('closed state') ||
    message.includes('Connection lost') ||
    message.includes('The client was disconnected by the server')
  )
}

/**
 * mysql2 refuses every command once its socket is gone, and there is no way to
 * revive it — so treat an enqueue-time rejection as proof the statement never
 * reached the server, which makes retrying it on a fresh connection safe.
 */
function isEnqueueRefusal(err: any): boolean {
  return String(err?.message || '').includes('closed state')
}

/** False as soon as mysql2 knows the socket has errored, closed, or been destroyed. */
function isUsable(conn: Connection | null): boolean {
  if (!conn) return false
  const core = (conn as unknown as { connection?: { state?: string } }).connection
  const state = core?.state
  // Older mysql2 builds have no `state` getter; assume usable and let the
  // per-connection `dead` flag and query errors catch the failure instead.
  if (!state) return true
  return state === 'authenticated' || state === 'connected'
}

async function openConnection(onLost?: () => void): Promise<Connection> {
  let conn: Connection
  try {
    conn = await mysql.createConnection(await buildOptions())
  } catch (err: any) {
    // A cached IAM token can be past its 15-minute window before the refresh
    // timer notices — after the machine sleeps, say. Mint a fresh one and try
    // once more before telling the user their credentials were rejected.
    const retryable = config.method === 'iam' && err?.code === 'ER_ACCESS_DENIED_ERROR' && iam
    if (!retryable) throw decorateError(err)
    try {
      await iam!.get(true)
    } catch {
      throw decorateError(err)
    }
    conn = await mysql.createConnection(await buildOptions()).catch((retryErr) => {
      throw decorateError(retryErr)
    })
  }
  // A dropped socket on an idle connection must not take the process down, but
  // it does have to be recorded — otherwise the dead connection stays cached and
  // every later query fails with "connection is in closed state" forever.
  conn.on('error', () => onLost?.())
  conn.on('end', () => onLost?.())
  return conn
}

/** Throws the connection away without waiting for a clean MySQL goodbye. */
function discard(conn: Connection | null): void {
  if (!conn) return
  try {
    conn.destroy()
  } catch {
    /* already gone */
  }
}

async function openControl(): Promise<Connection> {
  const conn: Connection = await openConnection(() => {
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

  await openControl()
  const [rows] = await control!.query<any[]>('SELECT VERSION() AS v')
  serverVersion = String(rows?.[0]?.[0] ?? rows?.[0]?.v ?? 'unknown')

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
 * with "Can't add new command when connection is in closed state"; dropping it
 * here means the next query silently opens a fresh one.
 */
async function pingAll(): Promise<void> {
  if (closed) return

  await Promise.all(
    [...tabConnections].map(async ([tabId, tc]) => {
      if (tc.busy) return
      const alive = !tc.dead && isUsable(tc.conn) && (await tc.conn.ping().then(() => true, () => false))
      if (alive) return
      tc.dead = true
      if (tabConnections.get(tabId) === tc) tabConnections.delete(tabId)
      discard(tc.conn)
    })
  )

  if (!control || closed) return
  const controlAlive =
    !controlDead && isUsable(control) && (await control.ping().then(() => true, () => false))
  if (controlAlive) return

  try {
    await reopenControl()
  } catch (err) {
    emit({ event: 'status', status: 'error', message: (err as Error).message })
  }
}

async function connectionForTab(tabId: string): Promise<TabConnection> {
  const existing = tabConnections.get(tabId)
  if (existing && !existing.dead && isUsable(existing.conn)) return existing
  if (existing) {
    // The cached socket is gone. mysql2 cannot revive one, so throw it away
    // rather than let it reject every future query on this tab.
    tabConnections.delete(tabId)
    discard(existing.conn)
  }

  const entry: TabConnection = {
    conn: null as unknown as Connection,
    threadId: 0,
    busy: false,
    lastUsed: Date.now(),
    dead: false
  }
  entry.conn = await openConnection(() => {
    entry.dead = true
  })
  entry.threadId = (entry.conn as unknown as { threadId: number }).threadId
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
  if (!isConnectionLost(err)) return false
  return isEnqueueRefusal(err) || isReadOnlyStatement(sql)
}

// ---------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------

function describeColumns(fields: FieldPacket[]): ColumnMeta[] {
  return (fields || []).map((f) => {
    const raw = f as unknown as Record<string, any>
    const type: number = raw.columnType ?? raw.type ?? 253
    const flags: number = raw.flags ?? 0
    return {
      name: f.name,
      orgName: raw.orgName || f.name,
      orgTable: raw.orgTable || raw.table || '',
      schema: raw.schema || raw.db || '',
      type,
      typeName: typeNameWithFlags(type, flags),
      isPrimaryKey: (flags & FLAG_PRI_KEY) !== 0,
      isNotNull: (flags & FLAG_NOT_NULL) !== 0,
      isAutoIncrement: (flags & FLAG_AUTO_INCREMENT) !== 0,
      isNumeric: isNumericType(type)
    }
  })
}

/**
 * A result is editable only when every real column comes from one table.
 * Computed/aliased columns without an `orgTable` are ignored for this test.
 */
function resolveEditTarget(columns: ColumnMeta[]): {
  schema: string | null
  table: string | null
  keyColumns: number[]
} {
  const tables = new Set<string>()
  for (const c of columns) {
    if (c.orgTable) tables.add(`${c.schema} ${c.orgTable}`)
  }
  if (tables.size !== 1) return { schema: null, table: null, keyColumns: [] }

  const [key] = [...tables]
  const [schema, table] = key.split(' ')

  let keyColumns = columns
    .map((c, i) => (c.isPrimaryKey && c.orgTable === table ? i : -1))
    .filter((i) => i >= 0)

  if (keyColumns.length === 0) {
    // Fall back to a plain `id` column, which covers most application schemas.
    const idIndex = columns.findIndex((c) => c.orgTable === table && c.orgName.toLowerCase() === 'id')
    if (idIndex >= 0) keyColumns = [idIndex]
  }

  return { schema: schema || null, table, keyColumns }
}

async function runStatement(
  entry: TabConnection,
  sql: string,
  limitRows: number
): Promise<ResultSet> {
  const started = process.hrtime.bigint()
  const [rows, fields] = await entry.conn.query<any>(sql)
  const executed = process.hrtime.bigint()

  const columns = describeColumns((fields as FieldPacket[]) || [])
  const durationMs = Number(executed - started) / 1e6

  if (!fields || (fields as FieldPacket[]).length === 0) {
    // DML/DDL: no result set, just an OkPacket.
    const ok = rows as { affectedRows?: number; info?: string; changedRows?: number }
    const affected = ok?.affectedRows ?? 0
    return {
      columns: [],
      rows: [],
      message: `${affected} row(s) affected`,
      affectedRows: affected,
      durationMs,
      fetchMs: 0,
      editSchema: null,
      editTable: null,
      keyColumns: [],
      truncated: false
    }
  }

  const cap = Math.min(limitRows || MAX_ROWS, MAX_ROWS)
  const source = rows as CellValue[][]
  const truncated = source.length > cap
  const data = truncated ? source.slice(0, cap) : source
  const fetchMs = Number(process.hrtime.bigint() - executed) / 1e6
  const target = resolveEditTarget(columns)

  return {
    columns,
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
    await withControl((c) => c.query(`KILL QUERY ${Number(entry.threadId)}`))
    return { killed: true }
  } catch {
    return { killed: false }
  }
}

async function runQuery(tabId: string, sql: string, limitRows?: number): Promise<QueryOutcome> {
  const statements = splitStatements(sql)
  if (statements.length === 0) throw new Error('Nothing to execute')

  let entry = await connectionForTab(tabId)
  if (entry.busy) throw new Error('This tab already has a query running')

  entry.busy = true
  const results: ResultSet[] = []
  const executed: string[] = []

  // Read timeout is enforced client-side: mysql2 has no per-query timeout, so
  // we kill the query from the control connection instead.
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

      // Track `USE` so new tab connections start in the same schema.
      if (firstKeyword(statement.text) === 'USE') {
        const m = /^\s*USE\s+`?([^`;\s]+)`?/i.exec(statement.text)
        if (m) currentSchema = m[1]
      }
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
async function withControl<T>(run: (conn: Connection) => Promise<T>): Promise<T> {
  if (!control) throw new Error('Not connected')
  if (controlDead || !isUsable(control)) await reopenControl()

  try {
    return await run(control!)
  } catch (err) {
    if (closed || !isConnectionLost(err)) throw err
    await reopenControl()
    return run(control!)
  }
}

async function listSchemas(conn: Connection): Promise<SchemaInfo[]> {
  const [schemaRows] = await conn.query<any[]>(
    'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME'
  )
  const [tableRows] = await conn.query<any[]>(
    `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
       FROM information_schema.TABLES
      ORDER BY TABLE_SCHEMA, TABLE_NAME`
  )

  const bySchema = new Map<string, SchemaInfo>()
  for (const row of schemaRows as any[][]) {
    const name = String(row[0])
    bySchema.set(name, { name, tables: [] })
  }
  for (const row of tableRows as any[][]) {
    const schema = String(row[0])
    const entry = bySchema.get(schema) ?? { name: schema, tables: [] }
    if (!bySchema.has(schema)) bySchema.set(schema, entry)
    entry.tables.push({
      name: String(row[1]),
      type: String(row[2]) === 'VIEW' ? 'view' : 'table'
    })
  }

  return [...bySchema.values()]
}

async function tableColumns(conn: Connection, schema: string, table: string): Promise<string[]> {
  const [rows] = await conn.query<any[]>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [schema, table]
  )
  return (rows as any[][]).map((r) => String(r[0]))
}

/** Every column in a schema in one round trip — the code-completion source. */
async function schemaColumns(conn: Connection, schema: string): Promise<Record<string, string[]>> {
  const [rows] = await conn.query<any[]>(
    `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [schema]
  )
  const out: Record<string, string[]> = {}
  for (const r of rows as any[][]) {
    const table = String(r[0])
    ;(out[table] ??= []).push(String(r[1]))
  }
  return out
}

async function tableDefinition(
  conn: Connection,
  schema: string,
  table: string
): Promise<TableDefinition> {
  const [tableRows] = await conn.query<any[]>(
    `SELECT ENGINE, TABLE_COLLATION, TABLE_COMMENT
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [schema, table]
  )
  const meta = (tableRows as any[][])[0]
  if (!meta) throw new Error(`Table ${schema}.${table} was not found`)
  const collation = meta[1] ? String(meta[1]) : ''
  const charset = collation ? collation.split('_')[0] : ''

  const [colRows] = await conn.query<any[]>(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA,
            CHARACTER_SET_NAME, COLLATION_NAME, COLUMN_COMMENT, ORDINAL_POSITION
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [schema, table]
  )

  const columns = (colRows as any[][]).map((r) => {
    const columnType = String(r[1])
    const extra = String(r[5] || '')
    return {
      name: String(r[0]),
      dataType: columnType,
      isPrimaryKey: String(r[3]) === 'PRI',
      isNullable: String(r[2]) === 'YES',
      isUnique: String(r[3]) === 'UNI',
      isBinary: /binary|blob/i.test(columnType),
      isUnsigned: /unsigned/i.test(columnType),
      isZeroFill: /zerofill/i.test(columnType),
      isAutoIncrement: /auto_increment/i.test(extra),
      isGenerated: /GENERATED/i.test(extra),
      defaultValue: r[4] === null ? null : String(r[4]),
      charset: r[6] === null ? null : String(r[6]),
      collation: r[7] === null ? null : String(r[7]),
      comment: String(r[8] || ''),
      ordinal: Number(r[9])
    }
  })

  const [indexRows] = await conn.query<any[]>(
    `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, COLLATION, SUB_PART,
            INDEX_TYPE, COMMENT, IS_VISIBLE
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [schema, table]
  ).catch(async () => {
    // IS_VISIBLE only exists from MySQL 8.0; retry without it on older servers.
    return conn.query<any[]>(
      `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, COLLATION, SUB_PART,
              INDEX_TYPE, COMMENT, 'YES'
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [schema, table]
    )
  })

  const indexMap = new Map<string, IndexInfo>()
  for (const r of indexRows as any[][]) {
    const name = String(r[0])
    const indexType = String(r[6] || 'BTREE')
    let type: IndexInfo['type'] = 'INDEX'
    if (name === 'PRIMARY') type = 'PRIMARY'
    else if (Number(r[1]) === 0) type = 'UNIQUE'
    else if (indexType === 'FULLTEXT') type = 'FULLTEXT'
    else if (indexType === 'SPATIAL') type = 'SPATIAL'

    let entry = indexMap.get(name)
    if (!entry) {
      entry = {
        name,
        type,
        storageType: indexType === 'FULLTEXT' || indexType === 'SPATIAL' ? '' : indexType,
        comment: String(r[7] || ''),
        visible: String(r[8] ?? 'YES') === 'YES',
        columns: []
      }
      indexMap.set(name, entry)
    }
    entry.columns.push({
      column: String(r[3]),
      seq: Number(r[2]),
      order: String(r[4] || 'A') === 'D' ? 'DESC' : 'ASC',
      length: r[5] === null ? null : Number(r[5])
    })
  }

  const [fkRows] = await conn.query<any[]>(
    `SELECT k.CONSTRAINT_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME,
            k.COLUMN_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE,
            k.ORDINAL_POSITION
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
        AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
      WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    [schema, table]
  )

  const fkMap = new Map<string, ForeignKeyInfo>()
  for (const r of fkRows as any[][]) {
    const name = String(r[0])
    let entry = fkMap.get(name)
    if (!entry) {
      entry = {
        name,
        referencedSchema: String(r[1] || ''),
        referencedTable: String(r[2] || ''),
        onUpdate: String(r[5] || ''),
        onDelete: String(r[6] || ''),
        columns: []
      }
      fkMap.set(name, entry)
    }
    entry.columns.push({ column: String(r[3]), referencedColumn: String(r[4]) })
  }

  return {
    schema,
    name: table,
    charset,
    collation,
    engine: String(meta[0] || 'InnoDB'),
    comment: String(meta[2] || ''),
    columns,
    indexes: [...indexMap.values()],
    foreignKeys: [...fkMap.values()]
  }
}

async function createStatement(
  conn: Connection,
  kind: 'table' | 'schema',
  schema: string,
  table?: string
): Promise<string> {
  if (kind === 'schema') {
    const [rows] = await conn.query<any[]>(`SHOW CREATE DATABASE \`${schema.replace(/`/g, '``')}\``)
    return String((rows as any[][])[0]?.[1] ?? '')
  }
  const [rows] = await conn.query<any[]>(
    `SHOW CREATE TABLE \`${schema.replace(/`/g, '``')}\`.\`${String(table).replace(/`/g, '``')}\``
  )
  return String((rows as any[][])[0]?.[1] ?? '')
}

async function charsets(conn: Connection): Promise<{ charset: string; collations: string[] }[]> {
  const [rows] = await conn.query<any[]>(
    'SELECT CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLLATIONS ORDER BY CHARACTER_SET_NAME, COLLATION_NAME'
  )
  const map = new Map<string, string[]>()
  for (const r of rows as any[][]) {
    const cs = String(r[0])
    if (!map.has(cs)) map.set(cs, [])
    map.get(cs)!.push(String(r[1]))
  }
  return [...map.entries()].map(([charset, collations]) => ({ charset, collations }))
}

async function testConnection(): Promise<{ serverVersion: string; latencyMs: number }> {
  const started = Date.now()
  let temporaryTunnel = false
  try {
    if (config.method === 'ssh' && !tunnel) {
      tunnel = await openTunnel(config, Math.max(1, prefs.connectTimeoutSec) * 1000)
      temporaryTunnel = true
    }
    const conn = await openConnection()
    try {
      const [rows] = await conn.query<any[]>('SELECT VERSION()')
      const version = String((rows as any[][])[0]?.[0] ?? 'unknown')
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
      return withControl(listSchemas)
    case 'tableDefinition':
      return withControl((c) => tableDefinition(c, req.schema, req.table))
    case 'tableColumns':
      return withControl((c) => tableColumns(c, req.schema, req.table))
    case 'schemaColumns':
      return withControl((c) => schemaColumns(c, req.schema))
    case 'createStatement':
      return withControl((c) => createStatement(c, req.kind, req.schema, req.table))
    case 'charsets':
      return withControl(charsets)
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
