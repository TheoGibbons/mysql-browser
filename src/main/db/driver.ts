/**
 * What the worker needs from a database server, and nothing more.
 *
 * The worker owns everything that is the same whatever we are talking to: the
 * SSH tunnel, the IAM token, one connection per query tab, keep-alive, evicting
 * dead sockets and retrying a statement that died in flight. A `Driver` owns the
 * parts that are not: the wire protocol, the catalogue queries and how you
 * cancel somebody else's running query.
 */

import type {
  CellValue,
  ColumnMeta,
  ConnectionConfig,
  DbEngine,
  Preferences,
  SchemaInfo,
  TableDefinition
} from '@shared/types'
import type { Tunnel } from './tunnel'

/** One physical connection to the server. */
export interface DriverConnection {
  /**
   * Server-side id for this session — a MySQL thread id or a Postgres backend
   * pid. Cancellation is addressed to it from a *different* connection.
   */
  readonly backendId: number
  query(sql: string, params?: unknown[]): Promise<RawResult>
  ping(): Promise<void>
  /** Closes politely, waiting for the server to acknowledge. */
  end(): Promise<void>
  /** Drops the socket now, without waiting. */
  destroy(): void
  /** False once the driver knows the socket has errored, closed or been destroyed. */
  isUsable(): boolean
}

export interface RawResult {
  columns: ColumnMeta[]
  rows: CellValue[][]
  affectedRows: number
  /** False for DML/DDL, which report a row count instead of a result set. */
  hasResultSet: boolean
}

/** Everything a driver needs from the worker to open a connection. */
export interface DriverContext {
  readonly config: ConnectionConfig
  readonly prefs: Preferences
  /** Set when the connection is tunnelled; the driver must dial its local end. */
  tunnel(): Tunnel | null
  /** Follows the last successful `USE` / `SET search_path`. */
  currentSchema(): string | undefined
  /** The saved password, or a freshly minted IAM token. */
  password(): Promise<string | undefined>
  /**
   * Mints a new IAM token and reports whether one was available — lets a driver
   * retry a rejected connection once with fresh credentials.
   */
  refreshPassword(): Promise<boolean>
  log(level: 'info' | 'warn' | 'error', message: string): void
}

export interface Driver {
  readonly engine: DbEngine

  /**
   * Opens one connection. `onLost` fires when its socket dies, so the worker can
   * stop handing the connection out.
   */
  open(onLost?: () => void): Promise<DriverConnection>

  /** Reported in the status bar once connected. */
  serverVersion(conn: DriverConnection): Promise<string>

  /** Cancels whatever `backendId` is running. Best-effort. */
  cancel(control: DriverConnection, backendId: number): Promise<void>

  /**
   * True for failures meaning "this socket is gone" rather than a SQL error the
   * server deliberately returned — those are recoverable by reconnecting.
   */
  isConnectionLost(err: unknown): boolean

  /**
   * True when the failure happened before the statement left the client, which
   * proves it did not run and makes retrying it safe whatever it was.
   */
  isEnqueueRefusal(err: unknown): boolean

  /** The schema a statement switched to, or null if it was not that kind of statement. */
  schemaFromStatement(sql: string): string | null

  /**
   * Where in `sql` the server says the failure is, as a 1-based character
   * offset, or null when it didn't say.
   *
   * This is what lets the editor underline the exact character the server
   * objected to, in the server's own words, instead of guessing.
   */
  errorPosition(err: unknown, sql: string): number | null

  // --- catalogue ---------------------------------------------------------
  listSchemas(conn: DriverConnection): Promise<SchemaInfo[]>
  tableColumns(conn: DriverConnection, schema: string, table: string): Promise<string[]>
  schemaColumns(conn: DriverConnection, schema: string): Promise<Record<string, string[]>>
  tableDefinition(conn: DriverConnection, schema: string, table: string): Promise<TableDefinition>
  createStatement(
    conn: DriverConnection,
    kind: 'table' | 'schema',
    schema: string,
    table?: string
  ): Promise<string>
  charsets(conn: DriverConnection): Promise<{ charset: string; collations: string[] }[]>
}

/**
 * A result is editable only when every real column comes from one table.
 * Computed/aliased columns without an `orgTable` are ignored for this test.
 */
export function resolveEditTarget(columns: ColumnMeta[]): {
  schema: string | null
  table: string | null
  keyColumns: number[]
} {
  const tables = new Set<string>()
  for (const c of columns) {
    if (c.orgTable) tables.add(`${c.schema} ${c.orgTable}`)
  }
  if (tables.size !== 1) return { schema: null, table: null, keyColumns: [] }

  const [key] = [...tables]
  const [schema, table] = key.split(' ')

  let keyColumns = columns
    .map((c, i) => (c.isPrimaryKey && c.orgTable === table ? i : -1))
    .filter((i) => i >= 0)

  if (keyColumns.length === 0) {
    // Fall back to a plain `id` column, which covers most application schemas.
    const idIndex = columns.findIndex(
      (c) => c.orgTable === table && c.orgName.toLowerCase() === 'id'
    )
    if (idIndex >= 0) keyColumns = [idIndex]
  }

  return { schema: schema || null, table, keyColumns }
}
