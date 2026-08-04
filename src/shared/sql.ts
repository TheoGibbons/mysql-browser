/**
 * SQL helpers shared by the renderer and the DB workers: identifier quoting,
 * literal escaping and statement splitting.
 */

import type { CellValue, ColumnMeta } from './types'

export function quoteIdent(name: string): string {
  return '`' + String(name).replace(/`/g, '``') + '`'
}

export function qualify(schema: string | null | undefined, table: string): string {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(table)}` : quoteIdent(table)
}

/** Escapes a value into a MySQL literal. Mirrors mysql2's escaping rules. */
export function escapeValue(value: CellValue | undefined, numeric = false): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (numeric && value !== '' && !Number.isNaN(Number(value))) return String(Number(value))
  return `'${escapeString(value)}'`
}

export function escapeString(value: string): string {
  return value.replace(/[\0\b\t\n\r\x1a"'\\]/g, (ch) => {
    switch (ch) {
      case '\0':
        return '\\0'
      case '\b':
        return '\\b'
      case '\t':
        return '\\t'
      case '\n':
        return '\\n'
      case '\r':
        return '\\r'
      case '\x1a':
        return '\\Z'
      case '"':
        return '\\"'
      case "'":
        return "\\'"
      default:
        return '\\\\'
    }
  })
}

export interface Statement {
  text: string
  /** Offset of the first character in the source string. */
  start: number
  /** Offset one past the last character (excluding the trailing delimiter). */
  end: number
}

/**
 * Splits a script into statements on `;`, ignoring delimiters that appear
 * inside string literals, backtick identifiers or comments.
 */
export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = []
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

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < sql.length) {
        if (sql[i] === '\\' && quote !== '`') {
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

    if (ch === '-' && next === '-' && (sql[i + 2] === undefined || /\s/.test(sql[i + 2]))) {
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }

    if (ch === '#') {
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }

    if (ch === '/' && next === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
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
export function statementAt(sql: string, offset: number): Statement | null {
  const statements = splitStatements(sql)
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

const READ_ONLY_STARTERS = new Set([
  'SELECT',
  'SHOW',
  'DESCRIBE',
  'DESC',
  'EXPLAIN',
  'USE',
  'SET',
  'HELP',
  'WITH',
  'ANALYZE',
  'CHECKSUM',
  'TABLE',
  'VALUES'
])

/** True when the statement cannot modify data or schema. */
export function isReadOnlyStatement(sql: string): boolean {
  const kw = firstKeyword(sql)
  if (!READ_ONLY_STARTERS.has(kw)) return false
  if (kw === 'WITH') {
    // A CTE can still wrap an INSERT/UPDATE/DELETE.
    return !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(stripComments(sql))
  }
  return true
}

/** True when any statement in the script would modify data or schema. */
export function hasModifyingStatement(sql: string): boolean {
  return splitStatements(sql).some((s) => !isReadOnlyStatement(s.text))
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
    /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|DATABASE|SCHEMA)\s+((?:`[^`]+`|[A-Za-z0-9_$]+)(?:\s*\.\s*(?:`[^`]+`|[A-Za-z0-9_$]+))?)/i
  const m = re.exec(cleaned)
  if (!m) return null
  const parts = m[1].split('.').map((p) => p.trim().replace(/^`|`$/g, ''))
  return parts[parts.length - 1] || null
}

export interface TableRef {
  /** Explicit qualifier, or `null` when the table was named on its own. */
  schema: string | null
  table: string
  alias: string | null
}

const IDENT_AT_START = /^(?:`([^`]+)`|([A-Za-z0-9_$]+))/

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
  return { name: m[1] ?? m[2], end: pos + m[0].length }
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
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  return String(value)
}

export function isNumericColumn(col: ColumnMeta): boolean {
  return col.isNumeric
}

/** `'a', 'b', 3` — the "Copy Row Values" format. */
export function rowValuesText(row: CellValue[], columns: ColumnMeta[]): string {
  return row.map((v, i) => escapeValue(v, columns[i]?.isNumeric ?? false)).join(', ')
}

export function columnNamesText(columns: ColumnMeta[]): string {
  return columns.map((c) => quoteIdent(c.name)).join(', ')
}

export function buildInsert(
  schema: string | null,
  table: string,
  columns: ColumnMeta[],
  rows: CellValue[][]
): string {
  const cols = columns.map((c) => quoteIdent(c.orgName || c.name)).join(', ')
  const values = rows
    .map((row) => `(${row.map((v, i) => escapeValue(v, columns[i]?.isNumeric ?? false)).join(', ')})`)
    .join(',\n  ')
  return `INSERT INTO ${qualify(schema, table)} (${cols})\nVALUES\n  ${values};`
}

/**
 * `INSERT ... SET` form. The SET syntax takes a single row, so each row becomes
 * its own statement.
 */
export function buildInsertSet(
  schema: string | null,
  table: string,
  columns: ColumnMeta[],
  rows: CellValue[][]
): string {
  return rows
    .map((row) => {
      const sets = columns
        .map((c, i) => `${quoteIdent(c.orgName || c.name)} = ${escapeValue(row[i], c.isNumeric)}`)
        .join(',\n    ')
      return `INSERT INTO ${qualify(schema, table)}\nSET\n    ${sets};`
    })
    .join('\n\n')
}

export function buildUpdate(
  schema: string | null,
  table: string,
  columns: ColumnMeta[],
  row: CellValue[],
  keyIndexes: number[]
): string {
  const sets = columns
    .map((c, i) => `${quoteIdent(c.orgName || c.name)} = ${escapeValue(row[i], c.isNumeric)}`)
    .join(',\n    ')
  const where = whereClause(columns, row, keyIndexes)
  return `UPDATE ${qualify(schema, table)}\nSET\n    ${sets}\nWHERE ${where};`
}

export function whereClause(
  columns: ColumnMeta[],
  row: CellValue[],
  keyIndexes: number[]
): string {
  const idx = keyIndexes.length > 0 ? keyIndexes : columns.map((_, i) => i)
  return idx
    .map((i) => {
      const c = columns[i]
      const v = row[i]
      const name = quoteIdent(c.orgName || c.name)
      return v === null ? `${name} IS NULL` : `${name} = ${escapeValue(v, c.isNumeric)}`
    })
    .join(' AND ')
}

/** Placeholder used in the "Copy insert statement" template, matching Workbench. */
export function placeholder(columnName: string): string {
  return `<{${columnName}: }>`
}
