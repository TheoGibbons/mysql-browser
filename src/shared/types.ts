/** Types shared between the main process, the DB workers and the renderer. */

export type ConnectionMethod = 'tcp' | 'ssh' | 'iam'

/** Which server a connection talks to. */
export type DbEngine = 'mysql' | 'postgres'

export const DEFAULT_PORTS: Record<DbEngine, number> = {
  mysql: 3306,
  postgres: 5432
}

/**
 * MySQL treats a database and a schema as the same thing, so one flat level of
 * "schemas" holds every table. Postgres nests schemas inside a database and a
 * connection can only see one database at a time, so `database` selects which
 * one and the tree then lists that database's schemas.
 */
export interface ConnectionConfig {
  id: string
  name: string
  method: ConnectionMethod
  engine: DbEngine

  /** Database server host. For `ssh` this is resolved from the SSH server's point of view. */
  host: string
  port: number
  user: string
  /** Not used by `iam`, which generates a token instead. */
  password?: string
  /** Postgres only — the database to connect to. MySQL gets this from `defaultSchema`. */
  database?: string
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
 * Narrows an unvalidated value — a field from an imported JSON file — to an
 * engine. Stored connections always carry a valid one, so this belongs at the
 * import boundary and nowhere else.
 */
export function toEngine(value: unknown): DbEngine {
  return value === 'postgres' ? 'postgres' : 'mysql'
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

/**
 * The passwords in a connections export, encrypted with a key derived from a
 * passphrase the user types. The at-rest encryption (`safeStorage`, DPAPI on
 * Windows) is bound to the machine and account that wrote it, so a copy of the
 * stored ciphertext is worthless on the machine being migrated to — the secrets
 * have to be re-wrapped in something the user can carry.
 *
 * The KDF parameters travel with the file so tightening them later cannot
 * strand an older export.
 */
export interface ConnectionSecretsEnvelope {
  v: 1
  kdf: 'scrypt'
  /** base64 */
  salt: string
  N: number
  r: number
  p: number
  keyLength: number
  cipher: 'aes-256-gcm'
  /** base64 */
  iv: string
  /** base64 GCM authentication tag — also what makes a wrong passphrase detectable. */
  tag: string
  /** base64 ciphertext of `{ [connectionId]: { password?, sshPassword?, sshPassphrase? } }`. */
  data: string
}

export interface Preferences {
  // General
  autoSaveIntervalSec: number
  maxTabSizeToSave: number
  // MySQL Session
  keepAliveIntervalSec: number
  readTimeoutSec: number
  connectTimeoutSec: number
  // Migration
  migrationConnectionTimeoutSec: number
}

export const DEFAULT_PREFERENCES: Preferences = {
  autoSaveIntervalSec: 15,
  maxTabSizeToSave: 1000000,
  keepAliveIntervalSec: 600,
  readTimeoutSec: 30,
  connectTimeoutSec: 60,
  migrationConnectionTimeoutSec: 60
}

// ---------------------------------------------------------------------------
// External tools (Data Export / Data Import)
// ---------------------------------------------------------------------------

/**
 * Where the dump tools live and which directories the user last used. These are
 * deliberately *not* preferences: nobody sets them up front, they are picked in
 * the Data Export/Import tab and remembered so the next tab opens where the last
 * one left off.
 */
export interface ToolSettings {
  mysqldumpPath: string
  mysqlPath: string
  pgDumpPath: string
  pgRestorePath: string
  psqlPath: string
  /** Directory the last dump was written to; also seeds result-grid exports. */
  exportDirectory: string
  /** Directory the last import file was chosen from. */
  importDirectory: string
}

export const DEFAULT_TOOL_SETTINGS: ToolSettings = {
  mysqldumpPath: '',
  mysqlPath: '',
  pgDumpPath: '',
  pgRestorePath: '',
  psqlPath: '',
  exportDirectory: '',
  importDirectory: ''
}

/** The tool a transfer tab drives. One per engine and direction. */
export type ToolName = 'mysqldump' | 'mysql' | 'pg_dump' | 'pg_restore' | 'psql'

export const TOOL_SETTING_KEYS: Record<ToolName, keyof ToolSettings> = {
  mysqldump: 'mysqldumpPath',
  mysql: 'mysqlPath',
  pg_dump: 'pgDumpPath',
  pg_restore: 'pgRestorePath',
  psql: 'psqlPath'
}

/** Progress and output from a running tool, streamed to the renderer. */
export type ToolRunEvent =
  | { runId: string; type: 'output'; stream: 'out' | 'err'; text: string }
  | { runId: string; type: 'info'; text: string }
  /** `total` is null when the size of the work is unknown (most dumps). */
  | { runId: string; type: 'progress'; bytes: number; total: number | null }
  | {
      runId: string
      type: 'exit'
      code: number | null
      signal: string | null
      cancelled: boolean
      /** Bytes written to the output file, when there was one. */
      bytes: number
      durationMs: number
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
  /**
   * True when the index only exists to enforce a constraint. Postgres refuses
   * to `DROP INDEX` one of these — it has to go through `DROP CONSTRAINT` —
   * and creates it as a table constraint rather than a `CREATE INDEX`.
   * Always false on MySQL, where an index is an index.
   */
  isConstraint: boolean
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
  /** Engine-specific type id: a MySQL protocol type, or a Postgres type OID. */
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
  /** See `IndexInfo.isConstraint`. */
  isConstraint: boolean
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

// ---------------------------------------------------------------------------
// Data Export / Data Import tabs
// ---------------------------------------------------------------------------

/** How much of a dump is structure and how much is data. */
export type DumpContents = 'structure-and-data' | 'data-only' | 'structure-only'

/** How `pg_dump` writes rows: `COPY` (fastest) or INSERT statements. */
export type PgInsertMode = 'copy' | 'inserts' | 'column-inserts'

/** `pg_dump --format`: plain SQL, directory, custom archive, tar archive. */
export type PgDumpFormat = 'p' | 'd' | 'c' | 't'

/**
 * Everything a Data Export / Data Import tab needs to rebuild its command, saved
 * with the tab. Both engines and both directions share one shape — a tab only
 * ever reads the fields that apply to it — so the state stays flat and
 * JSON-serialisable.
 */
export interface TransferState {
  /** Full path to the executable this tab runs. */
  toolPath: string

  /**
   * Ticked objects, keyed by schema, the value being the ticked table names. A
   * schema whose key is present with an empty array is included with none of its
   * tables (its routines and events only); a schema that is absent is not
   * exported at all.
   */
  selection: Record<string, string[]>
  /**
   * False while `selection` is still the empty default of a tab opened before
   * the schema list arrived; the tab fills it in as soon as one does, and never
   * touches it again.
   */
  seeded: boolean
  /**
   * Lists the server's own schemas in the object picker. Off by default: two of
   * them cannot be dumped at all, and the other two are for the rare job of
   * moving accounts or time zones between servers.
   */
  showSystemSchemas: boolean
  contents: DumpContents

  // --- MySQL ---
  routines: boolean
  events: boolean
  triggers: boolean
  includeCreateSchema: boolean
  singleTransaction: boolean
  /** Adds `--column-statistics=FALSE`, which an 8.0 client needs against 5.7. */
  skipColumnStatistics: boolean
  hexBlob: boolean
  completeInsert: boolean
  skipExtendedInsert: boolean
  /** Adds `--set-gtid-purged=OFF`, which RDS and replica dumps usually need. */
  gtidPurgedOff: boolean
  charset: string

  // --- Postgres ---
  pgClean: boolean
  pgIfExists: boolean
  pgCreate: boolean
  pgInserts: PgInsertMode
  pgFormat: PgDumpFormat
  pgNoOwner: boolean
  pgNoPrivileges: boolean
  pgVerbose: boolean

  // --- Export destination ---
  /** Directory the dump is written into. */
  outputDir: string
  /** File (or directory, for `--format=d`) name inside `outputDir`. */
  outputName: string

  // --- Import source ---
  inputPath: string
  /**
   * Where an import lands: the schema the dump is applied to on MySQL (empty
   * means the dump decides), or the database to connect to on Postgres.
   */
  targetSchema: string
  /** MySQL: keep going after a failed statement (`--force`). */
  force: boolean
  /** Postgres: the input is an archive for `pg_restore`, not SQL for `psql`. */
  pgArchive: boolean
  pgSingleTransaction: boolean
  pgStopOnError: boolean

  /**
   * The command the user edited by hand. Empty means the tab runs the command it
   * generates from the options above.
   */
  command: string
}

/** What the server said about the statement that failed, for the editor to mark. */
export interface QueryFailure {
  /** The statement as sent, so the editor can locate it in the tab's text. */
  statement: string
  /** 1-based offset into `statement` the server pointed at, when it gave one. */
  position: number | null
  message: string
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
  /** Set when the last run failed; cleared by the next run or the next edit. */
  failure?: QueryFailure | null
  designer: DesignerState | null
  /** Only set on `export`/`import` tabs. */
  transfer?: TransferState | null
  cursorLine: number
  updatedAt: number
}

export interface SessionMeta {
  connectionId: string
  tabIds: string[]
  activeTabId: string | null
  expandedSchemas: string[]
  activeSchema: string | null
  /** Lists the server's own schemas in the tree. Off by default. */
  showSystemSchemas: boolean
  schemas: SchemaInfo[]
  schemasFetchedAt: number
  layout: SessionLayout
}

export interface SessionLayout {
  sidebarWidth: number
  resultsHeight: number
  historyHeight: number
  /** Height of the output console in a Data Export / Data Import tab. */
  transferLogHeight: number
  historyColumns: HistoryColumnWidths
}

/** Drag-resizable history columns. The status icon gutter is a fixed size. */
export interface HistoryColumnWidths {
  seq: number
  time: number
  action: number
  message: number
  duration: number
}

export const DEFAULT_HISTORY_COLUMNS: HistoryColumnWidths = {
  seq: 46,
  time: 92,
  action: 520,
  message: 240,
  duration: 150
}

export const DEFAULT_LAYOUT: SessionLayout = {
  sidebarWidth: 260,
  resultsHeight: 300,
  historyHeight: 160,
  transferLogHeight: 120,
  historyColumns: { ...DEFAULT_HISTORY_COLUMNS }
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

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

/**
 * What the About dialog shows. The runtime versions ride along with the app's
 * own because they are the first thing worth knowing about a bug report.
 */
export interface AppInfo {
  /** The app's own version, straight from package.json. */
  version: string
  electron: string
  chrome: string
  node: string
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/**
 * Where the background updater has got to. `ready` means a new version is
 * staged and will be applied the next time the app closes.
 */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string }

export interface IpcError {
  message: string
  code?: string
  sqlState?: string
  /** MySQL error number, when the failure came from a MySQL server. */
  errno?: number
  /**
   * The statement that failed, verbatim as it was sent. The editor locates
   * this text in the tab to work out where to draw the marker.
   */
  statement?: string
  /** 1-based character offset into `statement` that the server objected to. */
  position?: number
}

/**
 * Envelope for every IPC call. Electron mangles thrown errors across the
 * boundary, so failures travel as data and the preload rethrows them.
 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }
