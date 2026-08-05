/**
 * Designer state that is the same whatever server it is headed for: building
 * state from a live table, blank state for a new one, and working out which
 * column in the editor corresponds to which column in the snapshot.
 *
 * The *SQL* differs per engine and lives in `./designerSql` (MySQL) and
 * `./designerSqlPg` (Postgres).
 */

import type {
  DbEngine,
  DesignerColumn,
  DesignerForeignKey,
  DesignerIndex,
  DesignerState,
  TableDefinition
} from '@shared/types'

/**
 * `canonical` maps a column's current name back to the one it had in the
 * snapshot, so an index or key on a renamed column still compares equal — both
 * servers carry a rename into them, so no DROP/ADD is needed.
 */
export type NameMapper = (name: string) => string

export const identity: NameMapper = (name) => name

export function indexSignature(index: DesignerIndex, canonical: NameMapper = identity): string {
  return [
    index.type,
    index.columns
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((c) => `${canonical(c.column)}:${c.order}:${c.length || ''}`)
      .join('|'),
    index.storageType,
    index.visible ? 'v' : 'i',
    index.comment
  ].join('~')
}

export function fkSignature(fk: DesignerForeignKey, canonical: NameMapper = identity): string {
  return [
    fk.referencedSchema,
    fk.referencedTable,
    fk.columns.map((c) => `${canonical(c.column)}>${c.referencedColumn}`).join('|'),
    fk.onUpdate,
    fk.onDelete
  ].join('~')
}

export interface ColumnMatch {
  /** Current column key -> the snapshot column it came from. */
  matched: Map<string, DesignerColumn>
  /** Snapshot columns with no counterpart left in the editor. */
  dropped: DesignerColumn[]
  /** Current name -> snapshot name, for columns that were renamed. */
  renamedBack: Map<string, string>
}

/**
 * Pairs the editor's columns with the snapshot's.
 *
 * Matching is by the stable designer key rather than by name; that is what
 * turns a rename into a rename instead of a DROP + ADD pair, which would throw
 * the column's data away. Name is only a fallback for state that predates the
 * key (or was rebuilt without one).
 */
export function matchColumns(state: DesignerState, original: DesignerState): ColumnMatch {
  const originalByKey = new Map(original.columns.map((c) => [c.key, c]))
  const originalByName = new Map(original.columns.map((c) => [c.name, c]))

  const matched = new Map<string, DesignerColumn>()
  const claimed = new Set<string>()

  for (const column of state.columns) {
    if (!column.name.trim()) continue
    const previous = originalByKey.get(column.key) ?? originalByName.get(column.name)
    if (previous && !claimed.has(previous.key)) {
      matched.set(column.key, previous)
      claimed.add(previous.key)
    }
  }

  const renamedBack = new Map<string, string>()
  for (const column of state.columns) {
    const previous = matched.get(column.key)
    if (previous && previous.name !== column.name) renamedBack.set(column.name, previous.name)
  }

  return {
    matched,
    dropped: original.columns.filter((c) => !claimed.has(c.key)),
    renamedBack
  }
}

/**
 * Rebuilds designer state from a live table so ALTER can diff against it.
 *
 * Type names are shown the way each server's own tooling writes them —
 * `VARCHAR(45)` for MySQL, `character varying(45)` for Postgres — so the
 * datatype column reads like the DDL the user would write by hand.
 */
export function designerFromDefinition(
  definition: TableDefinition,
  engine: DbEngine = 'mysql'
): DesignerState {
  const typeName = (raw: string): string => (engine === 'postgres' ? raw : raw.toUpperCase())
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
      dataType: typeName(c.dataType),
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
      isConstraint: idx.isConstraint,
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

export function emptyDesigner(schema: string, engine: DbEngine = 'mysql'): DesignerState {
  const isPostgres = engine === 'postgres'
  return {
    mode: 'create',
    schema,
    tableName: 'new_table',
    originalName: '',
    // Postgres takes its encoding from the database and has no storage engine,
    // so those stay empty rather than showing MySQL values it would reject.
    charset: isPostgres ? '' : 'utf8mb4',
    collation: isPostgres ? '' : 'utf8mb4_0900_ai_ci',
    engine: isPostgres ? '' : 'InnoDB',
    comment: '',
    columns: [
      {
        ...newDesignerColumn('c0'),
        name: 'id',
        dataType: isPostgres ? 'bigint' : 'INT',
        pk: true,
        nn: true,
        ai: true
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
