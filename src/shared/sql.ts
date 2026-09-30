/**
 * SQL helpers shared by the renderer and the DB workers: statement splitting,
 * classification and the statement builders behind the grid's copy actions.
 *
 * Anything that has to *write* an identifier or literal takes a `Dialect` —
 * see `./dialect`.
 */

import type { CellValue, ColumnMeta, DbEngine } from './types'
import { cellText, escapeValue, qualify, type Dialect } from './dialect'

export { escapeValue, qualify } from './dialect'

export interface Statement {
  text: string
  /** Offset of the first character in the source string. */
  start: number
  /** Offset one past the last character (excluding the trailing delimiter). */
  end: number
}

/** Matches the opening of a Postgres dollar-quoted body: `$$` or `$tag$`. */
const DOLLAR_QUOTE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/

const IDENT_CHAR = /[A-Za-z0-9_$]/

/**
 * True when the `'` at `at` opens a Postgres `E'…'` string — the one form in
 * that dialect where a backslash escapes the character after it.
 *
 * Exported so the editor's linter applies exactly the same rule; the two have
 * to agree on where a literal ends or they disagree about where statements do.
 */
export function opensEscapeString(sql: string, at: number): boolean {
  const prev = sql[at - 1]
  if (prev !== 'E' && prev !== 'e') return false
  const before = sql[at - 2]
  return before === undefined || !IDENT_CHAR.test(before)
}

/**
 * Splits a script into statements on `;`, ignoring delimiters that appear
 * inside string literals, quoted identifiers or comments.
 *
 * The engine matters here. Postgres bodies are wrapped in `$$ … $$`, which is
 * where a `CREATE FUNCTION` keeps its semicolons, and it has no backslash
 * escapes inside ordinary literals; MySQL has `#` comments and backticks.
 */
export function splitStatements(sql: string, engine: DbEngine = 'mysql'): Statement[] {
  const out: Statement[] = []
  const isPg = engine === 'postgres'
  let start = 0
  let i = 0

  const push = (end: number): void => {
    const text = sql.slice(start, end).trim()
    if (text.length > 0) {
      // Re-derive trimmed bounds so callers can map a statement back to the editor.
      const lead = sql.slice(start, end).length - sql.slice(start, end).trimStart().length
      out.push({ text, start: start + lead, end: start + lead + text.length })
    }
  }

  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (isPg && ch === '$') {
      const tag = DOLLAR_QUOTE.exec(sql.slice(i))
      if (tag) {
        const closing = tag[0]
        const end = sql.indexOf(closing, i + closing.length)
        // An unterminated body runs to the end of the script rather than
        // spilling its semicolons back into the splitter.
        i = end < 0 ? sql.length : end + closing.length
        continue
      }
    }

    if (ch === "'" || ch === '"' || (!isPg && ch === '`')) {
      const quote = ch
      // Backslash escapes inside any MySQL literal, but in Postgres only
      // inside `E'…'`. Reading a plain Postgres literal as escaped (or an
      // E-string as plain) misplaces the closing quote, which then swallows
      // the `;` after it and merges two statements into one.
      const backslashEscapes = isPg ? quote === "'" && opensEscapeString(sql, i) : quote !== '`'
      i++
      while (i < sql.length) {
        if (sql[i] === '\\' && backslashEscapes) {
          i += 2
          continue
        }
        if (sql[i] === quote) {
          // Doubled quote is an escaped quote, not a terminator.
          if (sql[i + 1] === quote) {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }

    // Postgres ends the line on any `--`; MySQL only when whitespace follows.
    if (ch === '-' && next === '-' && (isPg || sql[i + 2] === undefined || /\s/.test(sql[i + 2]))) {
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }

    if (!isPg && ch === '#') {
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }

    if (ch === '/' && next === '*') {
      i += 2
      // Postgres nests block comments; MySQL does not.
      let depth = 1
      while (i < sql.length && depth > 0) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else if (isPg && sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else {
          i++
        }
      }
      continue
    }

    if (ch === ';') {
      push(i)
      i++
      start = i
      continue
    }

    i++
  }

  push(sql.length)
  return out
}

/** Returns the statement containing `offset`, preferring the one just before the caret. */
export function statementAt(sql: string, offset: number, engine: DbEngine = 'mysql'): Statement | null {
  const statements = splitStatements(sql, engine)
  if (statements.length === 0) return null
  for (const st of statements) {
    // `<= end + 1` so a caret sitting right after the trailing `;` still matches.
    if (offset >= st.start && offset <= st.end + 1) return st
  }
  // Caret is in trailing whitespace: fall back to the last statement before it.
  let best: Statement | null = null
  for (const st of statements) {
    if (st.start <= offset) best = st
  }
  return best ?? statements[0]
}

const LEADING_KEYWORD = /^\s*(\w+)/

export function firstKeyword(sql: string): string {
  const m = LEADING_KEYWORD.exec(stripLeadingComments(sql))
  return m ? m[1].toUpperCase() : ''
}

export function stripLeadingComments(sql: string): string {
  let s = sql
  for (;;) {
    const before = s
    s = s.replace(/^\s+/, '')
    s = s.replace(/^--[^\n]*\n?/, '')
    s = s.replace(/^#[^\n]*\n?/, '')
    s = s.replace(/^\/\*[\s\S]*?\*\//, '')
    if (s === before) return s
  }
}

// `SET` and `WITH` are read-only only in some forms, and any of these stops
// being read-only once it selects `INTO` something; see `statementEffect`.
const READ_ONLY_STARTERS = new Set([
  'SELECT',
  'SHOW',
  'DESCRIBE',
  'DESC',
  'EXPLAIN',
  'USE',
  'HELP',
  'ANALYZE',
  'CHECKSUM',
  'TABLE',
  'VALUES'
])

/**
 * Leading keywords of statements known to change data, schema or server state.
 * This only picks the confirmation's wording: a statement that is neither here
 * nor provably read-only is still gated, as "couldn't confirm" instead.
 */
const WRITE_STARTERS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'TRUNCATE', 'LOAD', 'IMPORT',
  'CREATE', 'ALTER', 'DROP', 'RENAME', 'COMMENT', 'REFRESH',
  'GRANT', 'REVOKE', 'KILL', 'FLUSH', 'PURGE', 'INSTALL', 'UNINSTALL'
])

/**
 * String literals, quoted identifiers and comments, in whichever order they
 * open, so a keyword inside one isn't read as SQL. Same rules as
 * `splitStatements`: backslash escapes in every MySQL literal but only in
 * Postgres `E'…'`, `#` comments and backticks only in MySQL, `$$` bodies only
 * in Postgres. Getting these wrong misplaces a closing quote and hides the SQL
 * after it.
 */
const LITERALS_AND_COMMENTS: Record<DbEngine, RegExp> = {
  mysql:
    /'(?:[^'\\]|\\[\s\S]|'')*'|"(?:[^"\\]|\\[\s\S]|"")*"|`(?:[^`]|``)*`|\/\*[\s\S]*?\*\/|--(?=\s|$)[^\n]*|#[^\n]*/g,
  postgres:
    /\b[Ee]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$|\/\*[\s\S]*?\*\/|--[^\n]*/g
}

/**
 * Whether a `SET` reaches past the current session: server-wide or persisted
 * variables, account passwords, default roles, resource groups. Everything else
 * it can touch — user and session variables, `NAMES`, the next transaction's
 * characteristics, the active role — is gone when the connection closes.
 * Takes the statement with literals and comments masked out.
 */
function setOutlivesSession(text: string): boolean {
  const target = /^\s*SET\s+(\w+)/i.exec(text)?.[1].toUpperCase()
  if (target === 'PASSWORD' || target === 'DEFAULT' || target === 'RESOURCE') return true
  // One SET can mix scopes (`SET @a = 1, GLOBAL b = 2`), so check every
  // assignment. `\b` also matches the `@@global.b` spelling.
  return /\b(GLOBAL|PERSIST|PERSIST_ONLY)\b/i.test(text)
}

export type StatementEffect = 'read' | 'write' | 'unknown'

/**
 * What running a statement can do. `read` is an allowlist of statements proven
 * harmless, so anything unfamiliar — a typo, `CALL`, `BEGIN` — is `unknown`
 * and still treated as possibly modifying.
 */
export function statementEffect(sql: string, engine: DbEngine = 'mysql'): StatementEffect {
  const kw = firstKeyword(sql)
  const text = sql.replace(LITERALS_AND_COMMENTS[engine], ' ')
  if (kw === 'SET') return setOutlivesSession(text) ? 'write' : 'read'
  if (kw === 'WITH') {
    // A CTE can still wrap an INSERT/UPDATE/DELETE.
    if (/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(text)) return 'write'
  } else if (!READ_ONLY_STARTERS.has(kw)) {
    return WRITE_STARTERS.has(kw) ? 'write' : 'unknown'
  }
  // `INTO` anything but user variables writes: `INTO OUTFILE`/`DUMPFILE` put a
  // file on the MySQL server, and a Postgres `SELECT … INTO t` creates a table.
  // Checked for every read starter: Postgres `EXPLAIN ANALYZE SELECT … INTO t`
  // really does create t.
  return /\bINTO\b(?!\s*@)/i.test(text) ? 'write' : 'read'
}

/** True when the statement cannot modify data, schema or server state. */
export function isReadOnlyStatement(sql: string, engine: DbEngine = 'mysql'): boolean {
  return statementEffect(sql, engine) === 'read'
}

/**
 * Why a script needs the modify confirmation. `unknown` names the first
 * statement that couldn't be proven read-only (1-based) and its opening word.
 */
export type ModifyReason =
  | { kind: 'write' }
  | { kind: 'unknown'; statement: number; statements: number; opening: string }

/**
 * Why a script would need the modify confirmation, or `null` when every
 * statement is read-only. A known write outranks an unfamiliar statement:
 * it's the stronger warning, and it's certainly true.
 */
export function modifyReason(sql: string, engine: DbEngine = 'mysql'): ModifyReason | null {
  const statements = splitStatements(sql, engine)
  const effects = statements.map((s) => statementEffect(s.text, engine))
  if (effects.includes('write')) return { kind: 'write' }
  const index = effects.indexOf('unknown')
  if (index < 0) return null
  const opening = /^\S+/.exec(stripLeadingComments(statements[index].text))?.[0] ?? ''
  return {
    kind: 'unknown',
    statement: index + 1,
    statements: statements.length,
    opening: opening.slice(0, 40)
  }
}

export function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
}

/**
 * Best-effort table name for tab titles: the first table referenced after
 * FROM / JOIN / INTO / UPDATE / TABLE.
 */
export function guessTableName(sql: string): string | null {
  const cleaned = stripComments(sql)
  const re =
    /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|DATABASE|SCHEMA)\s+((?:`[^`]+`|"[^"]+"|[A-Za-z0-9_$]+)(?:\s*\.\s*(?:`[^`]+`|"[^"]+"|[A-Za-z0-9_$]+))?)/i
  const m = re.exec(cleaned)
  if (!m) return null
  const parts = m[1].split('.').map((p) => p.trim().replace(/^[`"]|[`"]$/g, ''))
  return parts[parts.length - 1] || null
}

export interface TableRef {
  /** Explicit qualifier, or `null` when the table was named on its own. */
  schema: string | null
  table: string
  alias: string | null
}

const IDENT_AT_START = /^(?:`([^`]+)`|"([^"]+)"|([A-Za-z0-9_$]+))/

/** Clause introducers that are followed by a comma-separated list of tables. */
const TABLE_CLAUSE = /\b(?:FROM|JOIN|INTO|UPDATE)\b/gi

/** Words that can sit where an alias would, but never are one. */
const NOT_AN_ALIAS = new Set([
  'as', 'on', 'using', 'where', 'group', 'order', 'having', 'limit', 'offset',
  'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'natural',
  'straight_join', 'union', 'intersect', 'except', 'set', 'values', 'select',
  'for', 'force', 'use', 'ignore', 'index', 'key', 'partition', 'lateral',
  'window', 'with', 'and', 'or', 'not', 'is', 'null', 'like', 'between', 'in',
  'exists', 'when', 'then', 'else', 'end', 'case', 'distinct', 'all',
  'returning', 'duplicate', 'into', 'from', 'update', 'delete', 'insert',
  'replace', 'table', 'procedure', 'desc', 'asc', 'low_priority', 'quick'
])

function readIdent(text: string, pos: number): { name: string; end: number } | null {
  const m = IDENT_AT_START.exec(text.slice(pos))
  if (!m) return null
  return { name: m[1] ?? m[2] ?? m[3], end: pos + m[0].length }
}

function skipSpace(text: string, pos: number): number {
  while (pos < text.length && /\s/.test(text[pos])) pos++
  return pos
}

/**
 * Best-effort list of the tables a statement reads or writes, with their
 * aliases — enough to offer their columns for completion. Subqueries and other
 * shapes we can't parse are skipped rather than guessed at.
 */
export function referencedTables(sql: string): TableRef[] {
  const text = stripComments(sql)
  const out: TableRef[] = []

  TABLE_CLAUSE.lastIndex = 0
  for (let clause = TABLE_CLAUSE.exec(text); clause; clause = TABLE_CLAUSE.exec(text)) {
    let pos = clause.index + clause[0].length

    // A comma-separated list: `from a, b as c, d.e f`.
    for (;;) {
      pos = skipSpace(text, pos)
      const first = readIdent(text, pos)
      if (!first) break
      pos = first.end

      let schema: string | null = null
      let table = first.name

      const afterName = skipSpace(text, pos)
      if (text[afterName] === '.') {
        const second = readIdent(text, skipSpace(text, afterName + 1))
        if (!second) break
        schema = table
        table = second.name
        pos = second.end
      }

      // Optional alias, with or without AS.
      let alias: string | null = null
      let cursor = skipSpace(text, pos)
      const maybeAs = readIdent(text, cursor)
      if (maybeAs && maybeAs.name.toLowerCase() === 'as') {
        const named = readIdent(text, skipSpace(text, maybeAs.end))
        if (named) {
          alias = named.name
          cursor = named.end
        }
      } else if (maybeAs && !NOT_AN_ALIAS.has(maybeAs.name.toLowerCase())) {
        alias = maybeAs.name
        cursor = maybeAs.end
      }

      out.push({ schema, table, alias })

      cursor = skipSpace(text, cursor)
      if (text[cursor] !== ',') break
      pos = cursor + 1
    }
  }

  return out
}

/** Formats a value the way the grid and clipboard helpers should show it. */
export function displayValue(value: CellValue): string {
  return cellText(value)
}

export function isNumericColumn(col: ColumnMeta): boolean {
  return col.isNumeric
}

/** `'a', 'b', 3` — the "Copy Row Values" format. */
export function rowValuesText(d: Dialect, row: CellValue[], columns: ColumnMeta[]): string {
  return row.map((v, i) => escapeValue(d, v, columns[i]?.isNumeric ?? false)).join(', ')
}

export function columnNamesText(d: Dialect, columns: ColumnMeta[]): string {
  return columns.map((c) => d.quoteIdent(c.name)).join(', ')
}

export function buildInsert(
  d: Dialect,
  schema: string | null,
  table: string,
  columns: ColumnMeta[],
  rows: CellValue[][]
): string {
  const cols = columns.map((c) => d.quoteIdent(c.orgName || c.name)).join(', ')
  const values = rows
    .map(
      (row) => `(${row.map((v, i) => escapeValue(d, v, columns[i]?.isNumeric ?? false)).join(', ')})`
    )
    .join(',\n  ')
  return `INSERT INTO ${qualify(d, schema, table)} (${cols})\nVALUES\n  ${values};`
}

/**
 * `INSERT ... SET` form. The SET syntax takes a single row, so each row becomes
 * its own statement. MySQL-only syntax, so Postgres gets the standard form.
 */
export function buildInsertSet(
  d: Dialect,
  schema: string | null,
  table: string,
  columns: ColumnMeta[],
  rows: CellValue[][]
): string {
  if (d.engine !== 'mysql') return buildInsert(d, schema, table, columns, rows)
  return rows
    .map((row) => {
      const sets = columns
        .map((c, i) => `${d.quoteIdent(c.orgName || c.name)} = ${escapeValue(d, row[i], c.isNumeric)}`)
        .join(',\n    ')
      return `INSERT INTO ${qualify(d, schema, table)}\nSET\n    ${sets};`
    })
    .join('\n\n')
}

export function buildUpdate(
  d: Dialect,
  schema: string | null,
  table: string,
  columns: ColumnMeta[],
  row: CellValue[],
  keyIndexes: number[]
): string {
  const sets = columns
    .map((c, i) => `${d.quoteIdent(c.orgName || c.name)} = ${escapeValue(d, row[i], c.isNumeric)}`)
    .join(',\n    ')
  const where = whereClause(d, columns, row, keyIndexes)
  return `UPDATE ${qualify(d, schema, table)}\nSET\n    ${sets}\nWHERE ${where};`
}

export function whereClause(
  d: Dialect,
  columns: ColumnMeta[],
  row: CellValue[],
  keyIndexes: number[]
): string {
  const idx = keyIndexes.length > 0 ? keyIndexes : columns.map((_, i) => i)
  return idx
    .map((i) => {
      const c = columns[i]
      const v = row[i]
      const name = d.quoteIdent(c.orgName || c.name)
      return v === null ? `${name} IS NULL` : `${name} = ${escapeValue(d, v, c.isNumeric)}`
    })
    .join(' AND ')
}

/** Placeholder used in the "Copy insert statement" template, matching Workbench. */
export function placeholder(columnName: string): string {
  return `<{${columnName}: }>`
}
