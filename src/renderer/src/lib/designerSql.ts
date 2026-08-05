/**
 * Turns the table designer's state into MySQL DDL.
 *
 * `create` emits a full CREATE TABLE. `alter` diffs against the snapshot taken
 * when the tab opened and emits only what actually changed.
 *
 * Postgres DDL comes out of `./designerSqlPg` — the two are kept apart on
 * purpose. MySQL says everything in one ALTER TABLE's comma-separated clauses,
 * where Postgres needs separate statements for renames, indexes and comments,
 * so a shared generator would be a knot of conditionals. The *diffing* is
 * common, and lives here for both to use.
 */

import type {
  DesignerColumn,
  DesignerForeignKey,
  DesignerIndex,
  DesignerState
} from '@shared/types'
import { mysqlDialect, qualify as qualifyWith } from '@shared/dialect'
import {
  designerFromDefinition,
  fkSignature,
  indexSignature,
  matchColumns,
  type NameMapper
} from './designerShared'

const q = (name: string): string => mysqlDialect.quoteIdent(name)
const esc = (value: string): string => mysqlDialect.escapeString(value)
const qualify = (schema: string | null | undefined, table: string): string =>
  qualifyWith(mysqlDialect, schema, table)

/** Defaults that are keywords rather than literals, so they must not be quoted. */
const BARE_DEFAULTS = /^(NULL|CURRENT_TIMESTAMP(\(\d*\))?|NOW\(\)|UUID\(\)|TRUE|FALSE|-?\d+(\.\d+)?)$/i

function defaultClause(column: DesignerColumn): string {
  const value = column.defaultValue.trim()
  if (value === '') return ''
  if (column.g) return ` GENERATED ALWAYS AS (${value}) STORED`
  if (BARE_DEFAULTS.test(value) || /^'.*'$/.test(value) || /^\(.*\)$/.test(value)) {
    return ` DEFAULT ${value}`
  }
  return ` DEFAULT '${esc(value)}'`
}

export function columnDefinition(column: DesignerColumn): string {
  const parts: string[] = [q(column.name), column.dataType || 'VARCHAR(255)']

  if (column.un && !/unsigned/i.test(column.dataType)) parts.push('UNSIGNED')
  if (column.zf && !/zerofill/i.test(column.dataType)) parts.push('ZEROFILL')
  if (column.b && /char|text/i.test(column.dataType) && !/binary/i.test(column.dataType)) {
    parts.push('BINARY')
  }
  if (column.charset) parts.push(`CHARACTER SET ${column.charset}`)
  if (column.collation) parts.push(`COLLATE ${column.collation}`)

  let sql = parts.join(' ')
  sql += column.nn ? ' NOT NULL' : ' NULL'
  sql += defaultClause(column)
  if (column.ai) sql += ' AUTO_INCREMENT'
  if (column.comment) sql += ` COMMENT '${esc(column.comment)}'`
  return sql
}

function indexColumnList(index: DesignerIndex): string {
  return index.columns
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((c) => {
      const length = c.length && c.length.trim() !== '' ? `(${c.length})` : ''
      return `${q(c.column)}${length} ${c.order}`
    })
    .join(', ')
}

function indexDefinition(index: DesignerIndex): string | null {
  if (index.columns.length === 0) return null
  const cols = indexColumnList(index)

  if (index.type === 'PRIMARY') return `PRIMARY KEY (${cols})`

  const name = q(index.name)
  let sql: string
  switch (index.type) {
    case 'UNIQUE':
      sql = `UNIQUE INDEX ${name} (${cols})`
      break
    case 'FULLTEXT':
      sql = `FULLTEXT INDEX ${name} (${cols})`
      break
    case 'SPATIAL':
      sql = `SPATIAL INDEX ${name} (${cols})`
      break
    default:
      sql = `INDEX ${name} (${cols})`
  }
  if (index.storageType && index.type !== 'FULLTEXT' && index.type !== 'SPATIAL') {
    sql += ` USING ${index.storageType}`
  }
  if (index.keyBlockSize && index.keyBlockSize !== '0') sql += ` KEY_BLOCK_SIZE = ${index.keyBlockSize}`
  if (index.parser) sql += ` WITH PARSER ${index.parser}`
  if (!index.visible) sql += ' INVISIBLE'
  if (index.comment) sql += ` COMMENT '${esc(index.comment)}'`
  return sql
}

function foreignKeyDefinition(fk: DesignerForeignKey): string | null {
  if (fk.skip || fk.columns.length === 0 || !fk.referencedTable) return null
  const local = fk.columns.map((c) => q(c.column)).join(', ')
  const remote = fk.columns.map((c) => q(c.referencedColumn)).join(', ')
  let sql = `CONSTRAINT ${q(fk.name)}\n    FOREIGN KEY (${local})\n    REFERENCES ${qualify(
    fk.referencedSchema,
    fk.referencedTable
  )} (${remote})`
  if (fk.onDelete) sql += `\n    ON DELETE ${fk.onDelete}`
  if (fk.onUpdate) sql += `\n    ON UPDATE ${fk.onUpdate}`
  return sql
}

export function buildCreateTable(state: DesignerState): string {
  const body: string[] = []

  for (const column of state.columns) {
    if (!column.name.trim()) continue
    body.push('  ' + columnDefinition(column))
  }

  const pkColumns = state.columns.filter((c) => c.pk && c.name.trim())
  const hasExplicitPrimary = state.indexes.some((i) => i.type === 'PRIMARY')
  if (pkColumns.length > 0 && !hasExplicitPrimary) {
    body.push(`  PRIMARY KEY (${pkColumns.map((c) => q(c.name)).join(', ')})`)
  }

  for (const column of state.columns) {
    if (column.uq && !column.pk && column.name.trim()) {
      body.push(`  UNIQUE INDEX ${q(`${column.name}_UNIQUE`)} (${q(column.name)} ASC)`)
    }
  }

  for (const index of state.indexes) {
    const sql = indexDefinition(index)
    if (sql) body.push('  ' + sql)
  }

  for (const fk of state.foreignKeys) {
    const sql = foreignKeyDefinition(fk)
    if (sql) body.push('  ' + sql)
  }

  if (body.length === 0) {
    return `-- Add at least one column before generating SQL.`
  }

  let sql = `CREATE TABLE ${qualify(state.schema, state.tableName || 'new_table')} (\n${body.join(
    ',\n'
  )}\n)`
  if (state.engine) sql += `\nENGINE = ${state.engine}`
  if (state.charset) sql += `\nDEFAULT CHARACTER SET = ${state.charset}`
  if (state.collation) sql += `\nCOLLATE = ${state.collation}`
  if (state.comment) sql += `\nCOMMENT = '${esc(state.comment)}'`
  return sql + ';'
}

// ---------------------------------------------------------------------------
// ALTER
// ---------------------------------------------------------------------------

export function buildAlterTable(state: DesignerState): string {
  const original = state.original
  if (!original) return buildCreateTable(state)

  const target = qualify(original.schema, original.name)
  const clauses: string[] = []

  // --- columns ---
  const originalDesigner = designerFromDefinition(original)
  const { matched, dropped, renamedBack } = matchColumns(state, originalDesigner)

  for (const column of dropped) clauses.push(`DROP COLUMN ${q(column.name)}`)

  state.columns.forEach((column, index) => {
    if (!column.name.trim()) return
    const previous = matched.get(column.key)

    if (!previous) {
      const after = index === 0 ? ' FIRST' : ` AFTER ${q(state.columns[index - 1].name)}`
      clauses.push(`ADD COLUMN ${columnDefinition(column)}${after}`)
      return
    }
    if (columnDefinition(previous) !== columnDefinition(column)) {
      clauses.push(`CHANGE COLUMN ${q(previous.name)} ${columnDefinition(column)}`)
    }
  })

  // --- primary key ---
  // Compared by identity too, so renaming a PK column doesn't drop and re-add
  // the key (which fails outright on an AUTO_INCREMENT column).
  const originalPk = originalDesigner.columns.filter((c) => c.pk)
  const currentPk = state.columns.filter((c) => c.pk && c.name.trim())
  const originalPkKeys = originalPk.map((c) => c.key).join(',')
  const currentPkKeys = currentPk.map((c) => matched.get(c.key)?.key ?? c.key).join(',')
  if (originalPkKeys !== currentPkKeys) {
    if (originalPk.length > 0) clauses.push('DROP PRIMARY KEY')
    if (currentPk.length > 0) {
      clauses.push(`ADD PRIMARY KEY (${currentPk.map((c) => q(c.name)).join(', ')})`)
    }
  }

  // Renames are already carried by CHANGE COLUMN, and MySQL updates the
  // indexes and keys that reference the column, so compare those under the
  // snapshot's names.
  const canonical: NameMapper = (name) => renamedBack.get(name) ?? name

  // --- indexes (PRIMARY handled above) ---
  const originalIndexes = new Map(
    originalDesigner.indexes.filter((i) => i.type !== 'PRIMARY').map((i) => [i.name, i])
  )
  const currentIndexes = new Map(
    state.indexes.filter((i) => i.type !== 'PRIMARY').map((i) => [i.name, i])
  )

  // MySQL creates an index of its own to back each foreign key, and refuses to
  // drop it while that key is still there. Those indexes are not the user's to
  // remove, so leaving one alone beats emitting SQL the server will reject.
  const keptFkNames = new Set(state.foreignKeys.filter((f) => !f.skip).map((f) => f.name))

  for (const [name, index] of originalIndexes) {
    const current = currentIndexes.get(name)
    if (!current || indexSignature(current, canonical) !== indexSignature(index)) {
      if (keptFkNames.has(name)) continue
      clauses.push(`DROP INDEX ${q(name)}`)
    }
  }
  for (const [name, index] of currentIndexes) {
    const previous = originalIndexes.get(name)
    if (!previous || indexSignature(previous) !== indexSignature(index, canonical)) {
      const sql = indexDefinition(index)
      if (sql) clauses.push(`ADD ${sql}`)
    }
  }

  // --- foreign keys ---
  const originalFks = new Map(originalDesigner.foreignKeys.map((f) => [f.name, f]))
  const currentFks = new Map(state.foreignKeys.filter((f) => !f.skip).map((f) => [f.name, f]))

  for (const [name, fk] of originalFks) {
    const current = currentFks.get(name)
    if (!current || fkSignature(current, canonical) !== fkSignature(fk)) {
      clauses.push(`DROP FOREIGN KEY ${q(name)}`)
    }
  }
  for (const [name, fk] of currentFks) {
    const previous = originalFks.get(name)
    if (!previous || fkSignature(previous) !== fkSignature(fk, canonical)) {
      const sql = foreignKeyDefinition(fk)
      if (sql) clauses.push(`ADD ${sql}`)
    }
  }

  // --- table options ---
  if (state.tableName && state.tableName !== original.name) {
    clauses.push(`RENAME TO ${qualify(state.schema, state.tableName)}`)
  }
  if (state.engine && state.engine !== original.engine) clauses.push(`ENGINE = ${state.engine}`)
  if (state.collation && state.collation !== original.collation) {
    clauses.push(`CHARACTER SET = ${state.charset} , COLLATE = ${state.collation}`)
  }
  if (state.comment !== original.comment) {
    clauses.push(`COMMENT = '${esc(state.comment)}'`)
  }

  if (clauses.length === 0) return `-- No changes to apply to ${target}.`
  return `ALTER TABLE ${target}\n${clauses.map((c) => '  ' + c).join(',\n')};`
}

export function buildMysqlDesignerSql(state: DesignerState): string {
  return state.mode === 'create' ? buildCreateTable(state) : buildAlterTable(state)
}
