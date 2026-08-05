/**
 * The parts of SQL that differ between the servers we speak to.
 *
 * Everything that builds SQL text — the results grid, the schema tree's context
 * menus, the table designer — goes through a `Dialect` rather than hard-coding
 * MySQL syntax. Getting one wrong is not cosmetic: backtick quoting is a syntax
 * error on Postgres, and MySQL's backslash escapes are silently *not* escapes on
 * a standard-conforming Postgres server, which turns a quoted literal into an
 * injection.
 */

import type { CellValue, DbEngine } from './types'

export interface Dialect {
  readonly engine: DbEngine
  /** Wraps an identifier in the server's quoting characters. */
  quoteIdent(name: string): string
  /** Escapes the *contents* of a single-quoted string literal. */
  escapeString(value: string): string
  /** A complete, quoted string literal — some servers need a prefix. */
  stringLiteral(value: string): string
  /** Statement that makes `schema` the default for unqualified names. */
  useSchema(schema: string): string
  /** How the UI should label a top-level tree node. */
  readonly schemaNoun: string
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

const MYSQL_ESCAPES: Record<string, string> = {
  '\0': '\\0',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\r': '\\r',
  '\x1a': '\\Z',
  '"': '\\"',
  "'": "\\'",
  '\\': '\\\\'
}

export const mysqlDialect: Dialect = {
  engine: 'mysql',
  schemaNoun: 'schema',
  quoteIdent(name) {
    return '`' + String(name).replace(/`/g, '``') + '`'
  },
  escapeString(value) {
    return value.replace(/[\0\b\t\n\r\x1a"'\\]/g, (ch) => MYSQL_ESCAPES[ch])
  },
  stringLiteral(value) {
    return `'${this.escapeString(value)}'`
  },
  useSchema(schema) {
    return `USE ${this.quoteIdent(schema)}`
  }
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

export const postgresDialect: Dialect = {
  engine: 'postgres',
  schemaNoun: 'schema',
  quoteIdent(name) {
    return '"' + String(name).replace(/"/g, '""') + '"'
  },
  /**
   * Postgres has no backslash escapes under `standard_conforming_strings` (on by
   * default since 9.1) — a quote is escaped by doubling it, and a backslash is
   * just a backslash. Control characters that cannot appear literally force the
   * E'' form, which `stringLiteral` adds.
   */
  escapeString(value) {
    return value.replace(/'/g, "''")
  },
  stringLiteral(value) {
    if (!/[\0\b\f\n\r\t\x1a\\]/.test(value)) return `'${value.replace(/'/g, "''")}'`
    // E'' strings do interpret backslashes, so everything must be escaped again.
    const escaped = value.replace(/[\0\b\f\n\r\t\x1a\\']/g, (ch) => {
      switch (ch) {
        case '\0':
          // A literal NUL cannot be stored in a Postgres text value at all.
          return ''
        case '\b':
          return '\\b'
        case '\f':
          return '\\f'
        case '\n':
          return '\\n'
        case '\r':
          return '\\r'
        case '\t':
          return '\\t'
        case '\x1a':
          return '\\x1a'
        case "'":
          return "''"
        default:
          return '\\\\'
      }
    })
    return `E'${escaped}'`
  },
  useSchema(schema) {
    return `SET search_path TO ${this.quoteIdent(schema)}`
  }
}

export const DIALECTS: Record<DbEngine, Dialect> = {
  mysql: mysqlDialect,
  postgres: postgresDialect
}

export function dialectFor(engine: DbEngine | undefined): Dialect {
  return engine === 'postgres' ? postgresDialect : mysqlDialect
}

// ---------------------------------------------------------------------------
// Shared value formatting
// ---------------------------------------------------------------------------

/** Renders a cell value as a SQL literal for the given dialect. */
export function escapeValue(d: Dialect, value: CellValue | undefined, numeric = false): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') {
    // Postgres will not compare a boolean column against 1.
    if (d.engine === 'postgres') return value ? 'TRUE' : 'FALSE'
    return value ? '1' : '0'
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (numeric && value !== '' && !Number.isNaN(Number(value))) return String(Number(value))
  return d.stringLiteral(value)
}

export function qualify(d: Dialect, schema: string | null | undefined, table: string): string {
  return schema ? `${d.quoteIdent(schema)}.${d.quoteIdent(table)}` : d.quoteIdent(table)
}
