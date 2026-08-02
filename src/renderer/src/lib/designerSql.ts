/**
 * Turns the table designer's state into SQL.
 *
 * `create` emits a full CREATE TABLE. `alter` diffs against the snapshot taken
 * when the tab opened and emits only what actually changed.
 */

import type {
  DesignerColumn,
  DesignerForeignKey,
  DesignerIndex,
  DesignerState,
  TableDefinition
} from '@shared/types'
import { qualify, quoteIdent, escapeString } from '@shared/sql'

/** Defaults that are keywords rather than literals, so they must not be quoted. */
const BARE_DEFAULTS = /^(NULL|CURRENT_TIMESTAMP(\(\d*\))?|NOW\(\)|UUID\(\)|TRUE|FALSE|-?\d+(\.\d+)?)$/i

function defaultClause(column: DesignerColumn): string {
  const value = column.defaultValue.trim()
  if (value === '') return ''
  if (column.g) return ` GENERATED ALWAYS AS (${value}) STORED`
  if (BARE_DEFAULTS.test(value) || /^'.*'$/.test(value) || /^\(.*\)$/.test(value)) {
    return ` DEFAULT ${value}`
  }
  return ` DEFAULT '${escapeString(value)}'`
}

export function columnDefinition(column: DesignerColumn): string {
  const parts: string[] = [quoteIdent(column.name), column.dataType || 'VARCHAR(255)']

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
  if (column.comment) sql += ` COMMENT '${escapeString(column.comment)}'`
  return sql
}

function indexColumnList(index: DesignerIndex): string {
  return index.columns
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((c) => {
      const length = c.length && c.length.trim() !== '' ? `(${c.length})` : ''
      return `${quoteIdent(c.column)}${length} ${c.order}`
    })
    .join(', ')
}

function indexDefinition(index: DesignerIndex): string | null {
  if (index.columns.length === 0) return null
  const cols = indexColumnList(index)

  if (index.type === 'PRIMARY') return `PRIMARY KEY (${cols})`

  const name = quoteIdent(index.name)
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
  if (index.comment) sql += ` COMMENT '${escapeString(index.comment)}'`
  return sql
}

function foreignKeyDefinition(fk: DesignerForeignKey): string | null {
  if (fk.skip || fk.columns.length === 0 || !fk.referencedTable) return null
  const local = fk.columns.map((c) => quoteIdent(c.column)).join(', ')
  const remote = fk.columns.map((c) => quoteIdent(c.referencedColumn)).join(', ')
  let sql = `CONSTRAINT ${quoteIdent(fk.name)}\n    FOREIGN KEY (${local})\n    REFERENCES ${qualify(
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
    body.push(`  PRIMARY KEY (${pkColumns.map((c) => quoteIdent(c.name)).join(', ')})`)
  }

  for (const column of state.columns) {
    if (column.uq && !column.pk && column.name.trim()) {
      body.push(`  UNIQUE INDEX ${quoteIdent(`${column.name}_UNIQUE`)} (${quoteIdent(column.name)} ASC)`)
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
  if (state.comment) sql += `\nCOMMENT = '${escapeString(state.comment)}'`
  return sql + ';'
}

// ---------------------------------------------------------------------------
// ALTER
// ---------------------------------------------------------------------------

function indexSignature(index: DesignerIndex): string {
  return [
    index.type,
    index.columns
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((c) => `${c.column}:${c.order}:${c.length || ''}`)
      .join('|'),
    index.storageType,
    index.visible ? 'v' : 'i',
    index.comment
  ].join('~')
}

function fkSignature(fk: DesignerForeignKey): string {
  return [
    fk.referencedSchema,
    fk.referencedTable,
    fk.columns.map((c) => `${c.column}>${c.referencedColumn}`).join('|'),
    fk.onUpdate,
    fk.onDelete
  ].join('~')
}

/** Rebuilds designer state from a live table so ALTER can diff against it. */
export function designerFromDefinition(definition: TableDefinition): DesignerState {
  return {
    mode: 'alter',
    schema: definition.schema,
    tableName: definition.name,
    originalName: definition.name,
    charset: definition.charset,
    collation: definition.collation,
    engine: definition.engine,
    comment: definition.comment,
    columns: definition.columns.map((c, i) => ({
      key: `c${i}`,
      name: c.name,
      dataType: c.dataType.toUpperCase(),
      pk: c.isPrimaryKey,
      nn: !c.isNullable,
      uq: c.isUnique,
      b: c.isBinary,
      un: c.isUnsigned,
      zf: c.isZeroFill,
      ai: c.isAutoIncrement,
      g: c.isGenerated,
      defaultValue: c.defaultValue ?? '',
      charset: c.charset ?? '',
      collation: c.collation ?? '',
      comment: c.comment
    })),
    indexes: definition.indexes.map((idx, i) => ({
      key: `i${i}`,
      name: idx.name,
      type: idx.type,
      storageType: idx.storageType,
      keyBlockSize: '0',
      parser: '',
      visible: idx.visible,
      comment: idx.comment,
      columns: idx.columns.map((c) => ({
        column: c.column,
        seq: c.seq,
        order: c.order,
        length: c.length === null ? '' : String(c.length)
      }))
    })),
    foreignKeys: definition.foreignKeys.map((fk, i) => ({
      key: `f${i}`,
      name: fk.name,
      referencedSchema: fk.referencedSchema,
      referencedTable: fk.referencedTable,
      onUpdate: fk.onUpdate,
      onDelete: fk.onDelete,
      comment: '',
      skip: false,
      columns: fk.columns.map((c) => ({ ...c }))
    })),
    activeSection: 'columns',
    original: definition
  }
}

export function buildAlterTable(state: DesignerState): string {
  const original = state.original
  if (!original) return buildCreateTable(state)

  const target = qualify(original.schema, original.name)
  const clauses: string[] = []

  // --- columns ---
  const originalByName = new Map(original.columns.map((c) => [c.name, c]))
  const currentNames = new Set(state.columns.map((c) => c.name).filter(Boolean))

  for (const column of original.columns) {
    if (!currentNames.has(column.name)) clauses.push(`DROP COLUMN ${quoteIdent(column.name)}`)
  }

  const originalDesigner = designerFromDefinition(original)
  const originalDesignerByName = new Map(originalDesigner.columns.map((c) => [c.name, c]))

  state.columns.forEach((column, index) => {
    if (!column.name.trim()) return
    const previous = originalDesignerByName.get(column.name)
    const after =
      index === 0 ? ' FIRST' : ` AFTER ${quoteIdent(state.columns[index - 1].name)}`

    if (!previous) {
      clauses.push(`ADD COLUMN ${columnDefinition(column)}${after}`)
      return
    }
    if (columnDefinition(previous) !== columnDefinition(column)) {
      clauses.push(`CHANGE COLUMN ${quoteIdent(previous.name)} ${columnDefinition(column)}`)
    }
  })

  // --- primary key ---
  const originalPk = original.columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
  const currentPk = state.columns.filter((c) => c.pk && c.name.trim()).map((c) => c.name)
  if (originalPk.join(',') !== currentPk.join(',')) {
    if (originalPk.length > 0) clauses.push('DROP PRIMARY KEY')
    if (currentPk.length > 0) {
      clauses.push(`ADD PRIMARY KEY (${currentPk.map(quoteIdent).join(', ')})`)
    }
  }

  // --- indexes (PRIMARY handled above) ---
  const originalIndexes = new Map(
    originalDesigner.indexes.filter((i) => i.type !== 'PRIMARY').map((i) => [i.name, i])
  )
  const currentIndexes = new Map(
    state.indexes.filter((i) => i.type !== 'PRIMARY').map((i) => [i.name, i])
  )

  for (const [name, index] of originalIndexes) {
    const current = currentIndexes.get(name)
    if (!current || indexSignature(current) !== indexSignature(index)) {
      clauses.push(`DROP INDEX ${quoteIdent(name)}`)
    }
  }
  for (const [name, index] of currentIndexes) {
    const previous = originalIndexes.get(name)
    if (!previous || indexSignature(previous) !== indexSignature(index)) {
      const sql = indexDefinition(index)
      if (sql) clauses.push(`ADD ${sql}`)
    }
  }

  // --- foreign keys ---
  const originalFks = new Map(originalDesigner.foreignKeys.map((f) => [f.name, f]))
  const currentFks = new Map(state.foreignKeys.filter((f) => !f.skip).map((f) => [f.name, f]))

  for (const [name, fk] of originalFks) {
    const current = currentFks.get(name)
    if (!current || fkSignature(current) !== fkSignature(fk)) {
      clauses.push(`DROP FOREIGN KEY ${quoteIdent(name)}`)
    }
  }
  for (const [name, fk] of currentFks) {
    const previous = originalFks.get(name)
    if (!previous || fkSignature(previous) !== fkSignature(fk)) {
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
    clauses.push(`COMMENT = '${escapeString(state.comment)}'`)
  }

  if (clauses.length === 0) return `-- No changes to apply to ${target}.`
  return `ALTER TABLE ${target}\n${clauses.map((c) => '  ' + c).join(',\n')};`
}

export function buildDesignerSql(state: DesignerState): string {
  return state.mode === 'create' ? buildCreateTable(state) : buildAlterTable(state)
}

export function emptyDesigner(schema: string): DesignerState {
  return {
    mode: 'create',
    schema,
    tableName: 'new_table',
    originalName: '',
    charset: 'utf8mb4',
    collation: 'utf8mb4_0900_ai_ci',
    engine: 'InnoDB',
    comment: '',
    columns: [
      {
        key: 'c0',
        name: 'id',
        dataType: 'INT',
        pk: true,
        nn: true,
        uq: false,
        b: false,
        un: false,
        zf: false,
        ai: true,
        g: false,
        defaultValue: '',
        charset: '',
        collation: '',
        comment: ''
      }
    ],
    indexes: [],
    foreignKeys: [],
    activeSection: 'columns',
    original: null
  }
}

export function newDesignerColumn(key: string): DesignerColumn {
  return {
    key,
    name: '',
    dataType: 'VARCHAR(45)',
    pk: false,
    nn: false,
    uq: false,
    b: false,
    un: false,
    zf: false,
    ai: false,
    g: false,
    defaultValue: '',
    charset: '',
    collation: '',
    comment: ''
  }
}
