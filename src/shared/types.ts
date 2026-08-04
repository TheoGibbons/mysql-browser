/** Types shared between the main process, the DB workers and the renderer. */

export type ConnectionMethod = 'tcp' | 'ssh' | 'iam'

export interface ConnectionConfig {
  id: string
  name: string
  method: ConnectionMethod

  /** MySQL server host. For `ssh` this is resolved from the SSH server's point of view. */
  host: string
  port: number
  user: string
  /** Not used by `iam`, which generates a token instead. */
  password?: string
  defaultSchema?: string

  // --- Standard TCP/IP over SSH ---
  sshHost?: string
  sshPort?: number
  sshUser?: string
  sshPassword?: string
  sshKeyFile?: string
  sshPassphrase?: string

  // --- AWS IAM ---
  /** Shell command producing an auth token on stdout, e.g. `aws rds generate-db-auth-token ...` */
  iamTokenCommand?: string

  // --- SSL ---
  useSSL?: boolean
  rejectUnauthorized?: boolean

  /** Per-connection preference overrides. Unset keys fall back to the global prefs. */
  prefs?: Partial<Preferences>

  /**
   * Hex colour (e.g. `#cc3333`) that tints the home card, the connection tab
   * and the query editor — used to make production connections stand out.
   * Empty/undefined means no colour.
   */
  color?: string

  /**
   * When true, a modifying statement (INSERT/UPDATE/DELETE/DDL) executed from
   * the editor triggers a loud extra confirmation before it runs. Intended for
   * production databases.
   */
  confirmModifying?: boolean

  /**
   * Home-screen group this connection sits in. Unset (or pointing at a group
   * that no longer exists) means it shows in the ungrouped area at the top.
   */
  groupId?: string | null

  createdAt: number
}

/**
 * A home-screen container for connections. Groups are deliberately unnamed —
 * they exist to cluster and collapse cards, so only their order, membership and
 * collapsed state are stored.
 */
export interface ConnectionGroup {
  id: string
  collapsed?: boolean
}

export interface Preferences {
  // General
  autoSaveIntervalSec: number
  maxTabSizeToSave: number
  // MySQL Session
  keepAliveIntervalSec: number
  readTimeoutSec: number
  connectTimeoutSec: number
  // Data export and import
  mysqldumpPath: string
  mysqlPath: string
  exportDirectory: string
  // Migration
  migrationConnectionTimeoutSec: number
}

export const DEFAULT_PREFERENCES: Preferences = {
  autoSaveIntervalSec: 15,
  maxTabSizeToSave: 1000000,
  keepAliveIntervalSec: 600,
  readTimeoutSec: 30,
  connectTimeoutSec: 60,
  mysqldumpPath: '',
  mysqlPath: '',
  exportDirectory: '',
  migrationConnectionTimeoutSec: 60
}

// ---------------------------------------------------------------------------
// Schema tree
// ---------------------------------------------------------------------------

export interface TableInfo {
  name: string
  type: 'table' | 'view'
}

export interface SchemaInfo {
  name: string
  tables: TableInfo[]
}

export interface ColumnInfo {
  name: string
  dataType: string
  isPrimaryKey: boolean
  isNullable: boolean
  isUnique: boolean
  isBinary: boolean
  isUnsigned: boolean
  isZeroFill: boolean
  isAutoIncrement: boolean
  isGenerated: boolean
  defaultValue: string | null
  charset: string | null
  collation: string | null
  comment: string
  ordinal: number
}

export interface IndexInfo {
  name: string
  type: 'PRIMARY' | 'UNIQUE' | 'INDEX' | 'FULLTEXT' | 'SPATIAL'
  storageType: string
  comment: string
  visible: boolean
  columns: { column: string; seq: number; order: 'ASC' | 'DESC'; length: number | null }[]
}

export interface ForeignKeyInfo {
  name: string
  referencedSchema: string
  referencedTable: string
  onUpdate: string
  onDelete: string
  columns: { column: string; referencedColumn: string }[]
}

export interface TableDefinition {
  schema: string
  name: string
  charset: string
  collation: string
  engine: string
  comment: string
  columns: ColumnInfo[]
  indexes: IndexInfo[]
  foreignKeys: ForeignKeyInfo[]
}

// ---------------------------------------------------------------------------
// Query results
// ---------------------------------------------------------------------------

export interface ColumnMeta {
  name: string
  /** Original column name in the table (differs from `name` when aliased). */
  orgName: string
  /** Original table, empty for computed columns. */
  orgTable: string
  schema: string
  /** mysql2 numeric type id. */
  type: number
  typeName: string
  isPrimaryKey: boolean
  isNotNull: boolean
  isAutoIncrement: boolean
  /** True when the value should be rendered/quoted as a number. */
  isNumeric: boolean
}

export type CellValue = string | number | boolean | null

export interface ResultSet {
  columns: ColumnMeta[]
  rows: CellValue[][]
  /** `1000 row(s) returned` or `3 row(s) affected`. */
  message: string
  affectedRows: number
  durationMs: number
  fetchMs: number
  /** Single source table, when the result maps cleanly onto one — required for editing. */
  editSchema: string | null
  editTable: string | null
  /** Column indexes forming the primary key of `editTable`. */
  keyColumns: number[]
  truncated: boolean
}

export interface QueryOutcome {
  /** One entry per statement executed. */
  results: ResultSet[]
  /** Statement text for each result, index-aligned with `results`. */
  statements: string[]
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export type TabKind = 'query' | 'export' | 'import' | 'designer'

export interface DesignerColumn {
  key: string
  name: string
  dataType: string
  pk: boolean
  nn: boolean
  uq: boolean
  b: boolean
  un: boolean
  zf: boolean
  ai: boolean
  g: boolean
  defaultValue: string
  charset: string
  collation: string
  comment: string
}

export interface DesignerIndex {
  key: string
  name: string
  type: IndexInfo['type']
  storageType: string
  keyBlockSize: string
  parser: string
  visible: boolean
  comment: string
  columns: { column: string; seq: number; order: 'ASC' | 'DESC'; length: string }[]
}

export interface DesignerForeignKey {
  key: string
  name: string
  referencedSchema: string
  referencedTable: string
  onUpdate: string
  onDelete: string
  comment: string
  skip: boolean
  columns: { column: string; referencedColumn: string }[]
}

export interface DesignerState {
  mode: 'create' | 'alter'
  schema: string
  tableName: string
  originalName: string
  charset: string
  collation: string
  engine: string
  comment: string
  columns: DesignerColumn[]
  indexes: DesignerIndex[]
  foreignKeys: DesignerForeignKey[]
  activeSection: 'columns' | 'indexes' | 'foreignKeys'
  /** Snapshot of the live table, used to diff for ALTER. */
  original: TableDefinition | null
}

export interface QueryTabState {
  id: string
  kind: TabKind
  title: string
  /** True when the user renamed nothing and the title should track the query's table. */
  autoTitle: boolean
  sql: string
  /** Persisted result grid (spec: rows are saved with the tab). */
  result: ResultSet | null
  /** Statement whose result is displayed. */
  resultStatement: string
  designer: DesignerState | null
  cursorLine: number
  updatedAt: number
}

export interface SessionMeta {
  connectionId: string
  tabIds: string[]
  activeTabId: string | null
  expandedSchemas: string[]
  activeSchema: string | null
  schemas: SchemaInfo[]
  schemasFetchedAt: number
  layout: SessionLayout
}

export interface SessionLayout {
  sidebarWidth: number
  resultsHeight: number
  historyHeight: number
}

export const DEFAULT_LAYOUT: SessionLayout = {
  sidebarWidth: 260,
  resultsHeight: 300,
  historyHeight: 160
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  id: string
  seq: number
  status: 'running' | 'ok' | 'error'
  startedAt: number
  action: string
  message: string
  durationMs: number | null
  fetchMs: number | null
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export type SessionStatus = 'offline' | 'connecting' | 'connected' | 'error'

export interface SessionStatusEvent {
  sessionId: string
  status: SessionStatus
  message?: string
  serverVersion?: string
}

export interface IpcError {
  message: string
  code?: string
  sqlState?: string
  /** MySQL error number, when the failure came from the server. */
  errno?: number
}

/**
 * Envelope for every IPC call. Electron mangles thrown errors across the
 * boundary, so failures travel as data and the preload rethrows them.
 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }
