/**
 * Client-side edit model for the results grid.
 *
 * Base rows are never mutated. Edits, deletions and pasted rows are tracked
 * alongside them so Revert is a single state reset and Apply can diff against
 * the original values to build a correct WHERE clause.
 */

import type { CellValue, ColumnMeta, ResultSet } from '@shared/types'
import { buildInsert, buildInsertSet, whereClause } from '@shared/sql'
import { escapeValue, qualify, type Dialect } from '@shared/dialect'

/** `>= 0` indexes a base row; `< 0` indexes an added row as `-1 - n`. */
export type RowRef = number

export const addedRef = (index: number): RowRef => -1 - index
export const addedIndex = (ref: RowRef): number => -1 - ref
export const isAdded = (ref: RowRef): boolean => ref < 0

export interface GridState {
  /** `"row:col"` -> new value, for base rows only. */
  edits: Record<string, CellValue>
  deleted: Record<number, true>
  added: CellValue[][]
  /** Edits applied to added rows are written straight into `added`. */
  selection: RowRef[]
  anchor: RowRef | null
  sort: { col: number; dir: 'asc' | 'desc' } | null
  columnWidths: Record<number, number>
}

export function emptyGridState(): GridState {
  return {
    edits: {},
    deleted: {},
    added: [],
    selection: [],
    anchor: null,
    sort: null,
    columnWidths: {}
  }
}

export const editKey = (row: number, col: number): string => `${row}:${col}`

export function isDirty(state: GridState): boolean {
  return (
    Object.keys(state.edits).length > 0 ||
    Object.keys(state.deleted).length > 0 ||
    state.added.length > 0
  )
}

/** Value currently shown for a cell, edits included. */
export function cellValue(result: ResultSet, state: GridState, ref: RowRef, col: number): CellValue {
  if (isAdded(ref)) return state.added[addedIndex(ref)]?.[col] ?? null
  const key = editKey(ref, col)
  if (key in state.edits) return state.edits[key]
  return result.rows[ref]?.[col] ?? null
}

export function isCellDirty(state: GridState, ref: RowRef, col: number): boolean {
  if (isAdded(ref)) return true
  return editKey(ref, col) in state.edits
}

/** Visible rows in display order: base rows minus deletions, then pasted rows. */
export function visibleRefs(result: ResultSet, state: GridState): RowRef[] {
  const refs: RowRef[] = []
  for (let i = 0; i < result.rows.length; i++) {
    if (!state.deleted[i]) refs.push(i)
  }
  for (let i = 0; i < state.added.length; i++) refs.push(addedRef(i))

  const sort = state.sort
  if (!sort) return refs

  const col = sort.col
  const numeric = result.columns[col]?.isNumeric ?? false
  const direction = sort.dir === 'asc' ? 1 : -1

  return refs.slice().sort((a, b) => {
    const va = cellValue(result, state, a, col)
    const vb = cellValue(result, state, b, col)
    if (va === null && vb === null) return 0
    // NULLs sort first ascending, matching MySQL's own ordering.
    if (va === null) return -1 * direction
    if (vb === null) return 1 * direction
    if (numeric) {
      const na = Number(va)
      const nb = Number(vb)
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return (na - nb) * direction
    }
    return String(va).localeCompare(String(vb), undefined, { numeric: true }) * direction
  })
}

export function cycleSort(
  current: GridState['sort'],
  col: number
): GridState['sort'] {
  if (!current || current.col !== col) return { col, dir: 'asc' }
  if (current.dir === 'asc') return { col, dir: 'desc' }
  return null
}

/** Extends the selection like a file list: plain / ctrl-toggle / shift-range. */
export function applySelection(
  refs: RowRef[],
  state: GridState,
  ref: RowRef,
  modifiers: { ctrl: boolean; shift: boolean }
): { selection: RowRef[]; anchor: RowRef | null } {
  if (modifiers.shift && state.anchor !== null) {
    const from = refs.indexOf(state.anchor)
    const to = refs.indexOf(ref)
    if (from >= 0 && to >= 0) {
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      return { selection: refs.slice(lo, hi + 1), anchor: state.anchor }
    }
  }
  if (modifiers.ctrl) {
    const has = state.selection.includes(ref)
    return {
      selection: has ? state.selection.filter((r) => r !== ref) : [...state.selection, ref],
      anchor: ref
    }
  }
  return { selection: [ref], anchor: ref }
}

// ---------------------------------------------------------------------------
// Apply: turn pending edits into SQL
// ---------------------------------------------------------------------------

export interface ApplyPlan {
  sql: string
  statementCount: number
  /** Set when the result cannot be written back. */
  blockedReason: string | null
}

export function buildApplyPlan(d: Dialect, result: ResultSet, state: GridState): ApplyPlan {
  if (!result.editTable) {
    return {
      sql: '',
      statementCount: 0,
      blockedReason: 'These results do not map onto a single table, so they cannot be edited.'
    }
  }
  if (result.keyColumns.length === 0) {
    return {
      sql: '',
      statementCount: 0,
      blockedReason:
        'No primary key or id column is present in the results, so rows cannot be identified.'
    }
  }

  const { columns, editSchema, editTable, keyColumns } = result
  const statements: string[] = []

  // UPDATEs: group edits by row so one row yields one statement.
  const editedRows = new Map<number, number[]>()
  for (const key of Object.keys(state.edits)) {
    const [rowText, colText] = key.split(':')
    const row = Number(rowText)
    if (state.deleted[row]) continue
    const cols = editedRows.get(row) ?? []
    cols.push(Number(colText))
    editedRows.set(row, cols)
  }

  for (const [row, cols] of [...editedRows.entries()].sort((a, b) => a[0] - b[0])) {
    const sets = cols
      .sort((a, b) => a - b)
      .map((col) => {
        const meta = columns[col]
        const value = state.edits[editKey(row, col)]
        return `${d.quoteIdent(meta.orgName || meta.name)} = ${escapeValue(d, value, meta.isNumeric)}`
      })
      .join(', ')
    // WHERE uses the *original* row so the key still matches even if it was edited.
    const where = whereClause(d, columns, result.rows[row], keyColumns)
    statements.push(`UPDATE ${qualify(d, editSchema, editTable)}\nSET ${sets}\nWHERE ${where};`)
  }

  for (const row of Object.keys(state.deleted).map(Number).sort((a, b) => a - b)) {
    const where = whereClause(d, columns, result.rows[row], keyColumns)
    statements.push(`DELETE FROM ${qualify(d, editSchema, editTable)}\nWHERE ${where};`)
  }

  if (state.added.length > 0) {
    statements.push(buildInsert(d, editSchema, editTable, columns, state.added))
  }

  return {
    sql: statements.join('\n\n'),
    statementCount: statements.length,
    blockedReason: statements.length === 0 ? 'There are no pending changes.' : null
  }
}

// ---------------------------------------------------------------------------
// Clipboard helpers
// ---------------------------------------------------------------------------

export function rowsToValuesText(
  d: Dialect,
  result: ResultSet,
  state: GridState,
  refs: RowRef[]
): string {
  return refs
    .map((ref) =>
      result.columns
        .map((c, i) => escapeValue(d, cellValue(result, state, ref, i), c.isNumeric))
        .join(', ')
    )
    .join('\r\n')
}

export function rowsWithNamesText(
  d: Dialect,
  result: ResultSet,
  state: GridState,
  refs: RowRef[]
): string {
  const header = result.columns.map((c) => d.quoteIdent(c.name)).join(', ')
  return `${header}\r\n${rowsToValuesText(d, result, state, refs)}`
}

export function rowsToInsert(
  d: Dialect,
  result: ResultSet,
  state: GridState,
  refs: RowRef[]
): string {
  const table = result.editTable ?? 'table_name'
  const rows = refs.map((ref) => result.columns.map((_, i) => cellValue(result, state, ref, i)))
  return buildInsert(d, result.editSchema, table, result.columns, rows)
}

export function rowsToInsertSet(
  d: Dialect,
  result: ResultSet,
  state: GridState,
  refs: RowRef[]
): string {
  const table = result.editTable ?? 'table_name'
  const rows = refs.map((ref) => result.columns.map((_, i) => cellValue(result, state, ref, i)))
  return buildInsertSet(d, result.editSchema, table, result.columns, rows)
}

export function rowsToUpdate(
  d: Dialect,
  result: ResultSet,
  state: GridState,
  refs: RowRef[]
): string {
  const table = result.editTable ?? 'table_name'
  const keys = result.keyColumns.length > 0 ? result.keyColumns : [0]
  return refs
    .map((ref) => {
      const row = result.columns.map((_, i) => cellValue(result, state, ref, i))
      const sets = result.columns
        .map((c, i) => `${d.quoteIdent(c.orgName || c.name)} = ${escapeValue(d, row[i], c.isNumeric)}`)
        .join(', ')
      return `UPDATE ${qualify(d, result.editSchema, table)}\nSET ${sets}\nWHERE ${whereClause(
        d,
        result.columns,
        row,
        keys
      )};`
    })
    .join('\n\n')
}

/**
 * Parses clipboard text into rows for "Paste row".
 * Accepts tab-separated (Excel) or comma-separated SQL-ish value lists.
 */
export function parsePastedRows(text: string, columnCount: number): CellValue[][] | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return null

  const rows: CellValue[][] = []
  for (const line of lines) {
    const cells = line.includes('\t') ? line.split('\t') : splitCsvish(line)
    if (cells.length !== columnCount) return null
    rows.push(cells.map(normaliseCell))
  }
  return rows
}

/** Splits `'a', 'b', 3` respecting quotes and escapes. */
function splitCsvish(line: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | null = null

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\' && i + 1 < line.length) {
        current += ch + line[i + 1]
        i++
        continue
      }
      if (ch === quote) {
        quote = null
        current += ch
        continue
      }
      current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === ',') {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out
}

function normaliseCell(raw: string): CellValue {
  const value = raw.trim()
  if (value === '' ) return ''
  if (/^null$/i.test(value)) return null
  if (/^'([\s\S]*)'$/.test(value) || /^"([\s\S]*)"$/.test(value)) {
    return value
      .slice(1, -1)
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\')
  }
  return value
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function toCsv(result: ResultSet, state: GridState, refs: RowRef[]): string {
  const escape = (value: CellValue): string => {
    if (value === null) return ''
    const text = String(value)
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const header = result.columns.map((c) => escape(c.name)).join(',')
  const body = refs
    .map((ref) => result.columns.map((_, i) => escape(cellValue(result, state, ref, i))).join(','))
    .join('\r\n')
  return `${header}\r\n${body}\r\n`
}

export function toJson(result: ResultSet, state: GridState, refs: RowRef[]): string {
  const objects = refs.map((ref) => {
    const obj: Record<string, CellValue> = {}
    result.columns.forEach((c, i) => {
      obj[c.name] = cellValue(result, state, ref, i)
    })
    return obj
  })
  return JSON.stringify(objects, null, 2)
}

export function toTsv(result: ResultSet, state: GridState, refs: RowRef[]): string {
  const header = result.columns.map((c) => c.name).join('\t')
  const body = refs
    .map((ref) =>
      result.columns
        .map((_, i) => {
          const v = cellValue(result, state, ref, i)
          return v === null ? 'NULL' : String(v).replace(/[\t\r\n]/g, ' ')
        })
        .join('\t')
    )
    .join('\r\n')
  return `${header}\r\n${body}\r\n`
}

export function toSqlInserts(
  d: Dialect,
  result: ResultSet,
  state: GridState,
  refs: RowRef[]
): string {
  const table = result.editTable ?? 'table_name'
  return refs
    .map((ref) => {
      const row = result.columns.map((_, i) => cellValue(result, state, ref, i))
      return buildInsert(d, result.editSchema, table, result.columns, [row])
    })
    .join('\n')
}

export function columnLabel(col: ColumnMeta): string {
  return col.name
}
