/**
 * Data Export / Data Import: everything that turns a tab's options into the
 * command line that actually runs, plus the parser the main process uses to run
 * it without a shell.
 *
 * The command is the contract between the two halves of the feature. The tab
 * generates it, the user may edit it, and the runner executes exactly what the
 * preview shows — so the builders here never hide an argument, and the parser
 * follows shell rules closely enough that a command pasted into a terminal
 * behaves the same way.
 *
 * The one thing that is *not* in the command is the password. It travels in a
 * temporary file the runner writes and deletes, which the command refers to
 * through `{password_file}` (MySQL) or the runner passes as `PGPASSFILE`
 * (Postgres), so a dump command can be copied, logged or pasted into a bug
 * report without leaking a credential.
 */

import type {
  ConnectionConfig,
  DbEngine,
  PgDumpFormat,
  SchemaInfo,
  ToolName,
  ToolSettings,
  TransferState
} from './types'
import { TOOL_SETTING_KEYS } from './types'

/** Replaced with the temporary option file holding the password. */
export const PASSWORD_FILE_TOKEN = '{password_file}'
/** Replaced with the address of the SSH tunnel the runner opens. */
export const TUNNEL_HOST_TOKEN = '{tunnel_host}'
export const TUNNEL_PORT_TOKEN = '{tunnel_port}'

export type TransferKind = 'export' | 'import'

// ---------------------------------------------------------------------------
// Names and paths
// ---------------------------------------------------------------------------

/**
 * Turns a connection name into something safe to embed in a file name on any
 * platform: no separators, no reserved characters, no runs of underscores.
 */
export function safeFileName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return (cleaned || 'connection').slice(0, 60)
}

/** `2026_08_11_13_37_36` — sorts chronologically and is safe in a file name. */
export function dumpTimestamp(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('_')
}

/** What a dump of this shape is called on disk. Directory dumps have no suffix. */
export function dumpFileName(
  connectionName: string,
  engine: DbEngine,
  format: PgDumpFormat,
  date = new Date()
): string {
  const suffix =
    engine === 'postgres'
      ? format === 'c'
        ? '.dump'
        : format === 't'
          ? '.tar'
          : format === 'd'
            ? ''
            : '.sql'
      : '.sql'
  return `${safeFileName(connectionName)}-${dumpTimestamp(date)}-dump${suffix}`
}

/** Joins with the separator the directory already uses, defaulting to the platform's. */
export function joinPath(dir: string, name: string, windows: boolean): string {
  if (!dir) return name
  if (!name) return dir
  const sep = /[\\]/.test(dir) ? '\\' : /\//.test(dir) ? '/' : windows ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`
}

/** The directory part of a path, or '' when there is none. */
export function dirNameOf(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  return index > 0 ? filePath.slice(0, index) : ''
}

/** The final segment of a path. */
export function baseNameOf(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  return index >= 0 ? filePath.slice(index + 1) : filePath
}

// ---------------------------------------------------------------------------
// Command-line quoting and parsing
// ---------------------------------------------------------------------------

/** Wraps a value in double quotes when a shell would otherwise split it. */
export function quoteArg(value: string): string {
  if (value === '') return '""'
  return /[\s"'<>|&^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** `--name="value"` — paths are always quoted so they stay readable when edited. */
function opt(name: string, value: string): string {
  return `--${name}=${quoteArg(value)}`
}

/** A path, always quoted — an unquoted one is a trap the moment it is edited. */
function quotePath(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** `--name="value"`, quoted even when it does not need to be (paths, files). */
function pathOpt(name: string, value: string): string {
  return `--${name}=${quotePath(value)}`
}

export interface ParsedCommand {
  argv: string[]
  /** File `<` feeds to the process's stdin. */
  stdinFile: string | null
  /** File `>`/`>>` sends the process's stdout to. */
  stdoutFile: string | null
  appendStdout: boolean
}

/**
 * Splits a command line the way a shell would, minus variable expansion and
 * globbing: double and single quotes group, `""` inside double quotes is a
 * literal quote, and `<`, `>` and `>>` redirect. Backslashes are left alone so
 * Windows paths survive without doubling.
 */
export function parseCommandLine(command: string): ParsedCommand {
  const argv: string[] = []
  let stdinFile: string | null = null
  let stdoutFile: string | null = null
  let appendStdout = false

  let current = ''
  let started = false
  /** Set when the next finished token is a redirection target. */
  let pending: 'in' | 'out' | 'append' | null = null

  const flush = (): void => {
    if (!started) return
    if (pending === 'in') stdinFile = current
    else if (pending === 'out' || pending === 'append') {
      stdoutFile = current
      appendStdout = pending === 'append'
    } else argv.push(current)
    pending = null
    current = ''
    started = false
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]

    if (ch === '"' || ch === "'") {
      started = true
      const quote = ch
      i++
      while (i < command.length) {
        if (command[i] === quote) {
          // "" inside a double-quoted run is an escaped quote, as cmd.exe reads it.
          if (quote === '"' && command[i + 1] === '"') {
            current += '"'
            i += 2
            continue
          }
          break
        }
        current += command[i]
        i++
      }
      continue
    }

    if (/\s/.test(ch)) {
      flush()
      continue
    }

    if (ch === '<' || ch === '>') {
      flush()
      if (ch === '>' && command[i + 1] === '>') {
        pending = 'append'
        i++
      } else {
        pending = ch === '<' ? 'in' : 'out'
      }
      continue
    }

    current += ch
    started = true
  }
  flush()

  return { argv, stdinFile, stdoutFile, appendStdout }
}

// ---------------------------------------------------------------------------
// Tab state
// ---------------------------------------------------------------------------

/** Which executable a tab drives, given its engine and direction. */
export function toolFor(kind: TransferKind, engine: DbEngine, pgArchive: boolean): ToolName {
  if (engine === 'postgres') {
    if (kind === 'export') return 'pg_dump'
    return pgArchive ? 'pg_restore' : 'psql'
  }
  return kind === 'export' ? 'mysqldump' : 'mysql'
}

export function toolPathFor(settings: ToolSettings, tool: ToolName): string {
  return settings[TOOL_SETTING_KEYS[tool]]
}

/**
 * What a fresh export starts with ticked. A Postgres connection is already
 * scoped to one database, so everything in it is the obvious default; MySQL sees
 * every database on the server, system ones included, so it starts with just the
 * schema the user is working in.
 */
export function seedSelection(
  engine: DbEngine,
  schemas: SchemaInfo[],
  preferred?: string | null
): Record<string, string[]> {
  const seeded = engine === 'postgres' ? schemas : schemas.filter((s) => s.name === preferred)
  const selection: Record<string, string[]> = {}
  for (const schema of seeded) selection[schema.name] = schema.tables.map((t) => t.name)
  return selection
}

export interface TransferDefaults {
  kind: TransferKind
  config: ConnectionConfig
  settings: ToolSettings
  /** Schema ticked to start with, when it exists. */
  activeSchema?: string | null
  schemas?: SchemaInfo[]
  now?: Date
}

export function defaultTransferState({
  kind,
  config,
  settings,
  activeSchema,
  schemas = [],
  now = new Date()
}: TransferDefaults): TransferState {
  const engine = config.engine
  const tool = toolFor(kind, engine, false)

  const preferred = activeSchema ?? config.defaultSchema ?? null

  return {
    toolPath: toolPathFor(settings, tool),
    selection: kind === 'export' ? seedSelection(engine, schemas, preferred) : {},
    // A tab opened before the schema list arrives has nothing to tick yet, and
    // seeds itself once it does.
    seeded: kind === 'import' || schemas.length > 0,
    showSystemSchemas: false,
    contents: 'structure-and-data',

    routines: false,
    events: false,
    triggers: true,
    includeCreateSchema: false,
    singleTransaction: true,
    skipColumnStatistics: true,
    hexBlob: false,
    completeInsert: false,
    skipExtendedInsert: false,
    // On, unlike mysqldump's own default: a dump taken from a GTID-enabled
    // server otherwise carries a GTID_PURGED statement that makes it refuse to
    // load into a server that has run transactions of its own, which is every
    // restore this app is for.
    gtidPurgedOff: true,
    charset: 'utf8mb4',

    pgClean: false,
    pgIfExists: false,
    pgCreate: false,
    pgInserts: 'copy',
    pgFormat: 'p',
    pgNoOwner: false,
    pgNoPrivileges: false,
    pgVerbose: true,

    outputDir: settings.exportDirectory,
    outputName: dumpFileName(config.name, engine, 'p', now),

    inputPath: '',
    // Postgres restores into a *database*, MySQL into a schema on the server it
    // is already connected to.
    targetSchema:
      kind !== 'import' ? '' : engine === 'postgres' ? (config.database ?? '') : (preferred ?? ''),
    force: false,
    pgArchive: false,
    pgSingleTransaction: false,
    pgStopOnError: true,

    command: ''
  }
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

export interface BuildContext {
  kind: TransferKind
  config: ConnectionConfig
  state: TransferState
  /** Live schema list, needed to tell a whole schema from a partial selection. */
  schemas: SchemaInfo[]
  windows: boolean
}

/** Where the tool should connect. SSH connections go through the runner's tunnel. */
function endpoint(config: ConnectionConfig): { host: string; port: string } {
  if (config.method === 'ssh') return { host: TUNNEL_HOST_TOKEN, port: TUNNEL_PORT_TOKEN }
  return { host: config.host || '127.0.0.1', port: String(config.port || '') }
}

/** Full path of the export destination. */
export function outputPathOf(state: TransferState, windows: boolean): string {
  return joinPath(state.outputDir, state.outputName, windows)
}

/** Schemas that are ticked, in a stable order. */
export function selectedSchemas(state: TransferState): string[] {
  return Object.keys(state.selection).sort((a, b) => a.localeCompare(b))
}

/** True when every table the server reports for `schema` is ticked. */
function isWholeSchema(state: TransferState, schemas: SchemaInfo[], schema: string): boolean {
  const live = schemas.find((s) => s.name === schema)
  if (!live) return true
  const ticked = new Set(state.selection[schema] ?? [])
  return live.tables.every((t) => ticked.has(t.name))
}

export function buildMysqlExport(ctx: BuildContext): string {
  const { config, state, schemas } = ctx
  const { host, port } = endpoint(config)
  const args: string[] = [quoteArg(state.toolPath || 'mysqldump')]

  // --defaults-file has to come first, and the password lives in it rather than
  // on the command line.
  args.push(pathOpt('defaults-file', PASSWORD_FILE_TOKEN))
  args.push(opt('host', host))
  if (port) args.push(opt('port', port))
  if (state.charset) args.push(opt('default-character-set', state.charset))
  args.push(opt('user', config.user || ''))
  args.push('--protocol=tcp')
  if (config.useSSL) args.push('--ssl-mode=REQUIRED')
  if (state.skipColumnStatistics) args.push('--column-statistics=FALSE')

  if (state.contents === 'data-only') args.push('--no-create-info')
  if (state.contents === 'structure-only') args.push('--no-data')
  if (state.routines) args.push('--routines')
  if (state.events) args.push('--events')
  if (!state.triggers) args.push('--skip-triggers')
  if (state.singleTransaction) args.push('--single-transaction=TRUE')
  if (state.hexBlob) args.push('--hex-blob')
  if (state.completeInsert) args.push('--complete-insert')
  if (state.skipExtendedInsert) args.push('--skip-extended-insert')
  if (state.gtidPurgedOff) args.push('--set-gtid-purged=OFF')

  args.push(pathOpt('result-file', outputPathOf(state, ctx.windows)))

  const dbs = selectedSchemas(state)
  const partial = dbs.filter((db) => !isWholeSchema(state, schemas, db))

  if (dbs.length === 1 && partial.length === 0 && !state.includeCreateSchema) {
    // The plain form: one database, every table, no CREATE DATABASE.
    args.push(quoteArg(dbs[0]))
  } else if (
    dbs.length === 1 &&
    (state.selection[dbs[0]] ?? []).length > 0 &&
    !state.includeCreateSchema &&
    !state.routines &&
    !state.events
  ) {
    // A subset of one database's tables. mysqldump only dumps routines and
    // events for a whole database, which is why this form is skipped when
    // either is wanted.
    args.push(quoteArg(dbs[0]), ...(state.selection[dbs[0]] ?? []).map(quoteArg))
  } else {
    // Several databases, or one that still needs CREATE DATABASE: --databases
    // takes whole schemas, so a partial selection is expressed by ignoring the
    // tables that were not ticked.
    args.push('--databases', ...dbs.map(quoteArg))
    if (!state.includeCreateSchema) args.push('--no-create-db')
    for (const db of dbs) {
      const live = schemas.find((s) => s.name === db)
      if (!live) continue
      const ticked = new Set(state.selection[db] ?? [])
      for (const table of live.tables) {
        if (!ticked.has(table.name)) args.push(opt('ignore-table', `${db}.${table.name}`))
      }
    }
  }

  return args.join(' ')
}

export function buildMysqlImport(ctx: BuildContext): string {
  const { config, state } = ctx
  const { host, port } = endpoint(config)
  const args: string[] = [quoteArg(state.toolPath || 'mysql')]

  args.push(pathOpt('defaults-file', PASSWORD_FILE_TOKEN))
  args.push(opt('host', host))
  if (port) args.push(opt('port', port))
  if (state.charset) args.push(opt('default-character-set', state.charset))
  args.push(opt('user', config.user || ''))
  args.push('--protocol=tcp')
  if (config.useSSL) args.push('--ssl-mode=REQUIRED')
  if (state.force) args.push('--force')
  if (state.targetSchema) args.push(quoteArg(state.targetSchema))

  // The mysql client has no --input-file, so the dump arrives on stdin. The
  // runner opens the file itself rather than going through a shell.
  return `${args.join(' ')} < ${quotePath(state.inputPath)}`
}

/**
 * A `pg_dump`/`pg_restore` object pattern. Names that are not plain lowercase
 * identifiers are double-quoted the way Postgres expects, and the whole pattern
 * then goes in single quotes so the shell leaves those quotes alone.
 */
function pgPattern(schema: string, table?: string): string {
  const part = (name: string): string =>
    /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
  const pattern = table === undefined ? part(schema) : `${part(schema)}.${part(table)}`
  return pattern.includes('"') ? `'${pattern}'` : `"${pattern}"`
}

/** Connection arguments shared by every Postgres tool. */
function pgConnectionArgs(config: ConnectionConfig, database: string): string[] {
  const { host, port } = endpoint(config)
  const args = [opt('host', host)]
  if (port) args.push(opt('port', port))
  args.push(opt('username', config.user || ''))
  // Without this the tool would sit waiting for a password on a terminal that
  // does not exist, instead of failing with a message.
  args.push('--no-password')
  if (database) args.push(opt('dbname', database))
  return args
}

export function buildPgExport(ctx: BuildContext): string {
  const { config, state, schemas } = ctx
  const args: string[] = [quoteArg(state.toolPath || 'pg_dump')]

  args.push(pathOpt('file', outputPathOf(state, ctx.windows)))
  args.push(...pgConnectionArgs(config, config.database || ''))
  args.push(opt('format', state.pgFormat))

  if (state.contents === 'data-only') args.push('--data-only')
  if (state.contents === 'structure-only') args.push('--schema-only')
  // pg_dump rejects --clean/--create alongside --data-only, so those only apply
  // to a dump that carries structure.
  if (state.contents !== 'data-only') {
    if (state.pgClean) args.push('--clean')
    if (state.pgClean && state.pgIfExists) args.push('--if-exists')
    if (state.pgCreate) args.push('--create')
  }
  if (state.pgInserts === 'inserts') args.push('--inserts')
  if (state.pgInserts === 'column-inserts') args.push('--column-inserts')
  if (state.pgNoOwner) args.push('--no-owner')
  if (state.pgNoPrivileges) args.push('--no-privileges')
  if (state.pgVerbose) args.push('--verbose')

  // Every schema ticked in full is left unfiltered: that dumps the database
  // itself — extensions, ownership, the lot — rather than a list of schemas.
  const dbs = selectedSchemas(state)
  const everything =
    schemas.length > 0 &&
    dbs.length === schemas.length &&
    dbs.every((db) => isWholeSchema(state, schemas, db))
  if (!everything) {
    for (const db of dbs) {
      if (isWholeSchema(state, schemas, db)) {
        args.push(`--schema=${pgPattern(db)}`)
      } else {
        for (const table of state.selection[db] ?? []) {
          args.push(`--table=${pgPattern(db, table)}`)
        }
      }
    }
  }

  return args.join(' ')
}

export function buildPgImport(ctx: BuildContext): string {
  const { config, state } = ctx
  const database = state.targetSchema || config.database || ''

  if (state.pgArchive) {
    const args: string[] = [quoteArg(state.toolPath || 'pg_restore')]
    args.push(...pgConnectionArgs(config, database))
    if (state.pgClean) args.push('--clean')
    if (state.pgClean && state.pgIfExists) args.push('--if-exists')
    if (state.pgCreate) args.push('--create')
    if (state.pgNoOwner) args.push('--no-owner')
    if (state.pgSingleTransaction) args.push('--single-transaction')
    if (state.pgVerbose) args.push('--verbose')
    // pg_restore reads the archive from a positional argument; --file would be
    // an *output* file and would write SQL instead of restoring it.
    args.push(quotePath(state.inputPath))
    return args.join(' ')
  }

  const args: string[] = [quoteArg(state.toolPath || 'psql')]
  args.push(...pgConnectionArgs(config, database))
  if (state.pgStopOnError) args.push('--set=ON_ERROR_STOP=on')
  if (state.pgSingleTransaction) args.push('--single-transaction')
  args.push(pathOpt('file', state.inputPath))
  return args.join(' ')
}

/** The command a tab would run, before any hand editing. */
export function buildCommand(ctx: BuildContext): string {
  if (ctx.config.engine === 'postgres') {
    return ctx.kind === 'export' ? buildPgExport(ctx) : buildPgImport(ctx)
  }
  return ctx.kind === 'export' ? buildMysqlExport(ctx) : buildMysqlImport(ctx)
}

/**
 * Why the tab cannot run yet, or null when it can. Checked against the options
 * rather than the command text, so the message points at the control to fix.
 */
export function transferBlockedReason(ctx: BuildContext): string | null {
  const { kind, state, config } = ctx
  if (!state.toolPath.trim()) {
    return `Set the path to ${toolFor(kind, config.engine, state.pgArchive)} first.`
  }
  if (kind === 'export') {
    if (selectedSchemas(state).length === 0) return 'Tick at least one schema or table to export.'
    if (!state.outputName.trim()) return 'Give the dump a file name.'
    if (!state.outputDir.trim()) return 'Choose a directory to export to.'
    return null
  }
  if (!state.inputPath.trim()) return 'Choose the file to import.'
  if (config.engine === 'postgres' && !(state.targetSchema || config.database)) {
    return 'Choose the database to import into.'
  }
  return null
}
