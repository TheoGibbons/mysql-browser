import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  DesignerColumn,
  DesignerForeignKey,
  DesignerIndex,
  DesignerState,
  SchemaInfo
} from '@shared/types'
import {
  buildDesignerSql,
  designerFromDefinition,
  emptyDesigner,
  newDesignerColumn
} from '../lib/designerSql'
import { Splitter } from './ui/Splitter'

const COMMON_TYPES = [
  'INT',
  'INT UNSIGNED',
  'BIGINT',
  'TINYINT(1)',
  'SMALLINT',
  'MEDIUMINT',
  'DECIMAL(10,2)',
  'FLOAT',
  'DOUBLE',
  'CHAR(36)',
  'VARCHAR(45)',
  'VARCHAR(255)',
  'TEXT',
  'MEDIUMTEXT',
  'LONGTEXT',
  'JSON',
  'DATE',
  'DATETIME',
  'TIMESTAMP',
  'TIME',
  'YEAR',
  'BLOB',
  'BINARY(16)',
  'ENUM(\'a\',\'b\')',
  'SET(\'a\',\'b\')'
]

const ENGINES = ['InnoDB', 'MyISAM', 'MEMORY', 'ARCHIVE', 'CSV']
const FK_ACTIONS = ['', 'RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION']
const INDEX_TYPES: DesignerIndex['type'][] = ['INDEX', 'UNIQUE', 'PRIMARY', 'FULLTEXT', 'SPATIAL']

const FALLBACK_CHARSETS = [
  { charset: 'utf8mb4', collations: ['utf8mb4_0900_ai_ci', 'utf8mb4_general_ci', 'utf8mb4_unicode_ci', 'utf8mb4_bin'] },
  { charset: 'latin1', collations: ['latin1_swedish_ci', 'latin1_general_ci', 'latin1_bin'] },
  { charset: 'ascii', collations: ['ascii_general_ci', 'ascii_bin'] }
]

interface Props {
  sessionId: string
  state: DesignerState
  schemas: SchemaInfo[]
  connected: boolean
  onChange(state: DesignerState): void
  /** Never runs SQL — opens a tab with the statement for the user to run. */
  onApply(sql: string): void
}

export function TableDesigner({
  sessionId,
  state,
  schemas,
  connected,
  onChange,
  onApply
}: Props): JSX.Element {
  const [detailHeight, setDetailHeight] = useState(170)
  const [selectedColumn, setSelectedColumn] = useState<string | null>(state.columns[0]?.key ?? null)
  const [selectedIndex, setSelectedIndex] = useState<string | null>(state.indexes[0]?.key ?? null)
  const [selectedFk, setSelectedFk] = useState<string | null>(state.foreignKeys[0]?.key ?? null)
  const [charsets, setCharsets] = useState(FALLBACK_CHARSETS)
  const [remoteColumns, setRemoteColumns] = useState<Record<string, string[]>>({})

  useEffect(() => {
    if (!connected) return
    let cancelled = false
    window.api.session
      .charsets(sessionId)
      .then((list) => {
        if (!cancelled && list.length > 0) setCharsets(list)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connected, sessionId])

  const patch = useCallback(
    (next: Partial<DesignerState>) => onChange({ ...state, ...next }),
    [onChange, state]
  )

  const sql = useMemo(() => buildDesignerSql(state), [state])

  const collationsFor = (charset: string): string[] =>
    charsets.find((c) => c.charset === charset)?.collations ?? []

  // --- columns ------------------------------------------------------------

  const patchColumn = (key: string, next: Partial<DesignerColumn>): void => {
    patch({ columns: state.columns.map((c) => (c.key === key ? { ...c, ...next } : c)) })
  }

  const addColumn = (): void => {
    const column = newDesignerColumn(`c${Date.now().toString(36)}`)
    patch({ columns: [...state.columns, column] })
    setSelectedColumn(column.key)
  }

  const removeColumn = (key: string): void => {
    patch({ columns: state.columns.filter((c) => c.key !== key) })
    if (selectedColumn === key) setSelectedColumn(null)
  }

  const moveColumn = (key: string, delta: number): void => {
    const index = state.columns.findIndex((c) => c.key === key)
    const target = index + delta
    if (index < 0 || target < 0 || target >= state.columns.length) return
    const columns = state.columns.slice()
    const [moved] = columns.splice(index, 1)
    columns.splice(target, 0, moved)
    patch({ columns })
  }

  const activeColumn = state.columns.find((c) => c.key === selectedColumn) ?? null

  // --- indexes ------------------------------------------------------------

  const patchIndex = (key: string, next: Partial<DesignerIndex>): void => {
    patch({ indexes: state.indexes.map((i) => (i.key === key ? { ...i, ...next } : i)) })
  }

  const addIndex = (): void => {
    const index: DesignerIndex = {
      key: `i${Date.now().toString(36)}`,
      name: `${state.tableName || 'table'}_idx_${state.indexes.length + 1}`,
      type: 'INDEX',
      storageType: 'BTREE',
      keyBlockSize: '0',
      parser: '',
      visible: true,
      comment: '',
      columns: []
    }
    patch({ indexes: [...state.indexes, index] })
    setSelectedIndex(index.key)
  }

  const activeIndex = state.indexes.find((i) => i.key === selectedIndex) ?? null

  const toggleIndexColumn = (column: string): void => {
    if (!activeIndex) return
    const has = activeIndex.columns.some((c) => c.column === column)
    const columns = has
      ? activeIndex.columns
          .filter((c) => c.column !== column)
          .map((c, i) => ({ ...c, seq: i + 1 }))
      : [
          ...activeIndex.columns,
          { column, seq: activeIndex.columns.length + 1, order: 'ASC' as const, length: '' }
        ]
    patchIndex(activeIndex.key, { columns })
  }

  // --- foreign keys -------------------------------------------------------

  const patchFk = (key: string, next: Partial<DesignerForeignKey>): void => {
    patch({ foreignKeys: state.foreignKeys.map((f) => (f.key === key ? { ...f, ...next } : f)) })
  }

  const addFk = (): void => {
    const fk: DesignerForeignKey = {
      key: `f${Date.now().toString(36)}`,
      name: `fk_${state.tableName || 'table'}_${state.foreignKeys.length + 1}`,
      referencedSchema: state.schema,
      referencedTable: '',
      onUpdate: '',
      onDelete: '',
      comment: '',
      skip: false,
      columns: []
    }
    patch({ foreignKeys: [...state.foreignKeys, fk] })
    setSelectedFk(fk.key)
  }

  const activeFk = state.foreignKeys.find((f) => f.key === selectedFk) ?? null

  // Referenced-table columns are fetched lazily so the FK editor can offer them.
  useEffect(() => {
    if (!connected || !activeFk?.referencedTable) return
    const key = `${activeFk.referencedSchema}.${activeFk.referencedTable}`
    if (remoteColumns[key]) return
    let cancelled = false
    window.api.session
      .tableColumns(sessionId, activeFk.referencedSchema, activeFk.referencedTable)
      .then((columns) => {
        if (!cancelled) setRemoteColumns((current) => ({ ...current, [key]: columns }))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connected, sessionId, activeFk?.referencedSchema, activeFk?.referencedTable, remoteColumns])

  const referencedColumns = activeFk
    ? (remoteColumns[`${activeFk.referencedSchema}.${activeFk.referencedTable}`] ?? [])
    : []

  const revert = (): void => {
    onChange(
      state.original
        ? designerFromDefinition(state.original)
        : { ...emptyDesigner(state.schema), tableName: state.tableName }
    )
  }

  // --- render -------------------------------------------------------------

  return (
    <div className="designer">
      <div className="designer-head">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'max-content 1fr max-content max-content',
            gap: '4px 8px',
            alignItems: 'center'
          }}
        >
          <label>Table Name:</label>
          <input
            className="field"
            value={state.tableName}
            onChange={(e) => patch({ tableName: e.target.value })}
          />
          <label>Schema:</label>
          <select
            className="field"
            style={{ minWidth: 150 }}
            value={state.schema}
            onChange={(e) => patch({ schema: e.target.value })}
          >
            {schemas.length === 0 && <option value={state.schema}>{state.schema}</option>}
            {schemas.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>

          <label>Charset/Collation:</label>
          <div className="row" style={{ gap: 6 }}>
            <select
              className="field"
              style={{ width: 150 }}
              value={state.charset}
              onChange={(e) => {
                const charset = e.target.value
                patch({ charset, collation: collationsFor(charset)[0] ?? '' })
              }}
            >
              {charsets.map((c) => (
                <option key={c.charset} value={c.charset}>
                  {c.charset}
                </option>
              ))}
            </select>
            <select
              className="field"
              style={{ width: 200 }}
              value={state.collation}
              onChange={(e) => patch({ collation: e.target.value })}
            >
              {collationsFor(state.charset).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <label>Engine:</label>
          <select
            className="field"
            style={{ minWidth: 150 }}
            value={state.engine}
            onChange={(e) => patch({ engine: e.target.value })}
          >
            {ENGINES.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>

          <label style={{ alignSelf: 'start', paddingTop: 3 }}>Comments:</label>
          <textarea
            className="field"
            style={{ gridColumn: 'span 3' }}
            rows={2}
            value={state.comment}
            onChange={(e) => patch({ comment: e.target.value })}
          />
        </div>
      </div>

      <div className="designer-body">
        {state.activeSection === 'columns' && (
          <div className="col fill">
            <div className="pane-head">
              <button className="toolbar-btn" onClick={addColumn}>
                + Column
              </button>
              <button
                className="toolbar-btn"
                disabled={!selectedColumn}
                onClick={() => selectedColumn && removeColumn(selectedColumn)}
              >
                − Remove
              </button>
              <div className="toolbar-sep" />
              <button
                className="toolbar-btn"
                disabled={!selectedColumn}
                onClick={() => selectedColumn && moveColumn(selectedColumn, -1)}
              >
                ↑
              </button>
              <button
                className="toolbar-btn"
                disabled={!selectedColumn}
                onClick={() => selectedColumn && moveColumn(selectedColumn, 1)}
              >
                ↓
              </button>
            </div>

            <div className="grid-wrap">
              <table className="editgrid">
                <colgroup>
                  <col style={{ width: '26%' }} />
                  <col style={{ width: '22%' }} />
                  {Array.from({ length: 8 }).map((_, i) => (
                    <col key={i} style={{ width: 30 }} />
                  ))}
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th>Column Name</th>
                    <th>Datatype</th>
                    <th title="Primary Key">PK</th>
                    <th title="Not Null">NN</th>
                    <th title="Unique">UQ</th>
                    <th title="Binary">B</th>
                    <th title="Unsigned">UN</th>
                    <th title="Zero Fill">ZF</th>
                    <th title="Auto Increment">AI</th>
                    <th title="Generated">G</th>
                    <th>Default/Expression</th>
                  </tr>
                </thead>
                <tbody>
                  {state.columns.map((column) => (
                    <tr
                      key={column.key}
                      className={selectedColumn === column.key ? 'selected' : ''}
                      onClick={() => setSelectedColumn(column.key)}
                    >
                      <td>
                        <input
                          type="text"
                          value={column.name}
                          placeholder="column_name"
                          onChange={(e) => patchColumn(column.key, { name: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          list="designer-types"
                          value={column.dataType}
                          onChange={(e) => patchColumn(column.key, { dataType: e.target.value })}
                        />
                      </td>
                      {(
                        [
                          ['pk', 'pk'],
                          ['nn', 'nn'],
                          ['uq', 'uq'],
                          ['b', 'b'],
                          ['un', 'un'],
                          ['zf', 'zf'],
                          ['ai', 'ai'],
                          ['g', 'g']
                        ] as [keyof DesignerColumn, string][]
                      ).map(([flag]) => (
                        <td key={String(flag)} className="check">
                          <input
                            type="checkbox"
                            checked={Boolean(column[flag])}
                            onChange={(e) => {
                              const next: Partial<DesignerColumn> = { [flag]: e.target.checked } as any
                              // A primary key column is implicitly NOT NULL.
                              if (flag === 'pk' && e.target.checked) next.nn = true
                              patchColumn(column.key, next)
                            }}
                          />
                        </td>
                      ))}
                      <td>
                        <input
                          type="text"
                          value={column.defaultValue}
                          placeholder="NULL"
                          onChange={(e) => patchColumn(column.key, { defaultValue: e.target.value })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <datalist id="designer-types">
                {COMMON_TYPES.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>

            <Splitter
              orientation="horizontal"
              size={detailHeight}
              grow="after"
              min={90}
              max={420}
              onResize={setDetailHeight}
            />

            <div className="pane" style={{ height: detailHeight, flex: 'none', overflow: 'auto' }}>
              {activeColumn ? (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 12,
                    padding: 8
                  }}
                >
                  <div className="form-grid" style={{ gridTemplateColumns: 'max-content 1fr' }}>
                    <label>Column Name:</label>
                    <input
                      className="field"
                      value={activeColumn.name}
                      onChange={(e) => patchColumn(activeColumn.key, { name: e.target.value })}
                    />
                    <label>Charset/Collation:</label>
                    <div className="row" style={{ gap: 5 }}>
                      <select
                        className="field"
                        style={{ flex: 1 }}
                        value={activeColumn.charset}
                        onChange={(e) =>
                          patchColumn(activeColumn.key, { charset: e.target.value, collation: '' })
                        }
                      >
                        <option value="">Default Charset</option>
                        {charsets.map((c) => (
                          <option key={c.charset} value={c.charset}>
                            {c.charset}
                          </option>
                        ))}
                      </select>
                      <select
                        className="field"
                        style={{ flex: 1 }}
                        value={activeColumn.collation}
                        onChange={(e) => patchColumn(activeColumn.key, { collation: e.target.value })}
                      >
                        <option value="">Default Collation</option>
                        {collationsFor(activeColumn.charset).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                    <label style={{ alignSelf: 'start', paddingTop: 3 }}>Comments:</label>
                    <textarea
                      className="field"
                      rows={4}
                      value={activeColumn.comment}
                      onChange={(e) => patchColumn(activeColumn.key, { comment: e.target.value })}
                    />
                  </div>

                  <div className="form-grid" style={{ gridTemplateColumns: 'max-content 1fr' }}>
                    <label>Data Type:</label>
                    <input
                      className="field"
                      list="designer-types"
                      value={activeColumn.dataType}
                      onChange={(e) => patchColumn(activeColumn.key, { dataType: e.target.value })}
                    />
                    <label>Default:</label>
                    <input
                      className="field"
                      value={activeColumn.defaultValue}
                      onChange={(e) => patchColumn(activeColumn.key, { defaultValue: e.target.value })}
                    />
                    <label style={{ alignSelf: 'start', paddingTop: 3 }}>Storage:</label>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
                      {(
                        [
                          ['pk', 'Primary Key'],
                          ['nn', 'Not Null'],
                          ['uq', 'Unique'],
                          ['b', 'Binary'],
                          ['un', 'Unsigned'],
                          ['zf', 'Zero Fill'],
                          ['ai', 'Auto Increment'],
                          ['g', 'Generated']
                        ] as [keyof DesignerColumn, string][]
                      ).map(([flag, label]) => (
                        <label className="checkline" key={String(flag)}>
                          <input
                            type="checkbox"
                            checked={Boolean(activeColumn[flag])}
                            onChange={(e) =>
                              patchColumn(activeColumn.key, {
                                [flag]: e.target.checked,
                                ...(flag === 'pk' && e.target.checked ? { nn: true } : {})
                              } as Partial<DesignerColumn>)
                            }
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="grid-placeholder">Select a column to edit its details.</div>
              )}
            </div>
          </div>
        )}

        {state.activeSection === 'indexes' && (
          <div className="row fill" style={{ alignItems: 'stretch' }}>
            <div className="col" style={{ width: 300, borderRight: '1px solid var(--border)' }}>
              <div className="pane-head">
                <span className="pane-title">Indexes</span>
                <div className="spacer" />
                <button className="toolbar-btn" onClick={addIndex}>
                  + Add
                </button>
                <button
                  className="toolbar-btn"
                  disabled={!selectedIndex}
                  onClick={() => {
                    patch({ indexes: state.indexes.filter((i) => i.key !== selectedIndex) })
                    setSelectedIndex(null)
                  }}
                >
                  − Remove
                </button>
              </div>
              <div className="grid-wrap">
                <table className="editgrid">
                  <thead>
                    <tr>
                      <th>Index Name</th>
                      <th style={{ width: 90 }}>Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.indexes.map((index) => (
                      <tr
                        key={index.key}
                        className={selectedIndex === index.key ? 'selected' : ''}
                        onClick={() => setSelectedIndex(index.key)}
                      >
                        <td>
                          <input
                            type="text"
                            value={index.name}
                            onChange={(e) => patchIndex(index.key, { name: e.target.value })}
                          />
                        </td>
                        <td>
                          <select
                            className="field"
                            style={{ width: '100%', height: 18, border: 0, background: 'transparent' }}
                            value={index.type}
                            onChange={(e) =>
                              patchIndex(index.key, { type: e.target.value as DesignerIndex['type'] })
                            }
                          >
                            {INDEX_TYPES.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="col fill">
              <div className="pane-head">
                <span className="pane-title">Index Columns</span>
              </div>
              <div className="grid-wrap">
                {activeIndex ? (
                  <table className="editgrid">
                    <colgroup>
                      <col />
                      <col style={{ width: 40 }} />
                      <col style={{ width: 70 }} />
                      <col style={{ width: 70 }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>Column</th>
                        <th>#</th>
                        <th>Order</th>
                        <th>Length</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.columns.map((column) => {
                        const entry = activeIndex.columns.find((c) => c.column === column.name)
                        return (
                          <tr key={column.key}>
                            <td style={{ paddingLeft: 4 }}>
                              <label className="checkline" style={{ width: '100%' }}>
                                <input
                                  type="checkbox"
                                  checked={Boolean(entry)}
                                  onChange={() => toggleIndexColumn(column.name)}
                                />
                                {column.name}
                              </label>
                            </td>
                            <td style={{ textAlign: 'center' }}>{entry?.seq ?? ''}</td>
                            <td>
                              {entry && (
                                <select
                                  style={{ width: '100%', height: 18, border: 0, background: 'transparent' }}
                                  value={entry.order}
                                  onChange={(e) =>
                                    patchIndex(activeIndex.key, {
                                      columns: activeIndex.columns.map((c) =>
                                        c.column === column.name
                                          ? { ...c, order: e.target.value as 'ASC' | 'DESC' }
                                          : c
                                      )
                                    })
                                  }
                                >
                                  <option value="ASC">ASC</option>
                                  <option value="DESC">DESC</option>
                                </select>
                              )}
                            </td>
                            <td>
                              {entry && (
                                <input
                                  type="text"
                                  value={entry.length}
                                  onChange={(e) =>
                                    patchIndex(activeIndex.key, {
                                      columns: activeIndex.columns.map((c) =>
                                        c.column === column.name ? { ...c, length: e.target.value } : c
                                      )
                                    })
                                  }
                                />
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                ) : (
                  <div className="grid-placeholder">Select an index.</div>
                )}
              </div>
            </div>

            <div
              className="col"
              style={{ width: 220, borderLeft: '1px solid var(--border)', padding: 8, gap: 6 }}
            >
              <span className="pane-title">Index Options</span>
              {activeIndex && (
                <div className="form-grid" style={{ gridTemplateColumns: 'max-content 1fr' }}>
                  <label>Storage Type:</label>
                  <select
                    className="field"
                    value={activeIndex.storageType}
                    onChange={(e) => patchIndex(activeIndex.key, { storageType: e.target.value })}
                  >
                    <option value="">(default)</option>
                    <option value="BTREE">BTREE</option>
                    <option value="HASH">HASH</option>
                  </select>
                  <label>Key Block Size:</label>
                  <input
                    className="field"
                    value={activeIndex.keyBlockSize}
                    onChange={(e) => patchIndex(activeIndex.key, { keyBlockSize: e.target.value })}
                  />
                  <label>Parser:</label>
                  <input
                    className="field"
                    value={activeIndex.parser}
                    onChange={(e) => patchIndex(activeIndex.key, { parser: e.target.value })}
                  />
                  <label>Visible:</label>
                  <input
                    type="checkbox"
                    checked={activeIndex.visible}
                    onChange={(e) => patchIndex(activeIndex.key, { visible: e.target.checked })}
                  />
                  <label style={{ alignSelf: 'start', paddingTop: 3 }}>Comment:</label>
                  <textarea
                    className="field"
                    rows={4}
                    value={activeIndex.comment}
                    onChange={(e) => patchIndex(activeIndex.key, { comment: e.target.value })}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {state.activeSection === 'foreignKeys' && (
          <div className="row fill" style={{ alignItems: 'stretch' }}>
            <div className="col" style={{ width: 340, borderRight: '1px solid var(--border)' }}>
              <div className="pane-head">
                <span className="pane-title">Foreign Keys</span>
                <div className="spacer" />
                <button className="toolbar-btn" onClick={addFk}>
                  + Add
                </button>
                <button
                  className="toolbar-btn"
                  disabled={!selectedFk}
                  onClick={() => {
                    patch({ foreignKeys: state.foreignKeys.filter((f) => f.key !== selectedFk) })
                    setSelectedFk(null)
                  }}
                >
                  − Remove
                </button>
              </div>
              <div className="grid-wrap">
                <table className="editgrid">
                  <thead>
                    <tr>
                      <th>Foreign Key Name</th>
                      <th style={{ width: 140 }}>Referenced Table</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.foreignKeys.map((fk) => (
                      <tr
                        key={fk.key}
                        className={selectedFk === fk.key ? 'selected' : ''}
                        onClick={() => setSelectedFk(fk.key)}
                      >
                        <td>
                          <input
                            type="text"
                            value={fk.name}
                            onChange={(e) => patchFk(fk.key, { name: e.target.value })}
                          />
                        </td>
                        <td>
                          <select
                            style={{ width: '100%', height: 18, border: 0, background: 'transparent' }}
                            value={`${fk.referencedSchema}.${fk.referencedTable}`}
                            onChange={(e) => {
                              const [schema, ...rest] = e.target.value.split('.')
                              patchFk(fk.key, {
                                referencedSchema: schema,
                                referencedTable: rest.join('.'),
                                columns: []
                              })
                            }}
                          >
                            <option value=".">(select)</option>
                            {schemas.flatMap((s) =>
                              s.tables.map((t) => (
                                <option key={`${s.name}.${t.name}`} value={`${s.name}.${t.name}`}>
                                  {s.name}.{t.name}
                                </option>
                              ))
                            )}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="col fill">
              <div className="pane-head">
                <span className="pane-title">Columns</span>
              </div>
              <div className="grid-wrap">
                {activeFk ? (
                  <table className="editgrid">
                    <thead>
                      <tr>
                        <th>Column</th>
                        <th>Referenced Column</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.columns.map((column) => {
                        const entry = activeFk.columns.find((c) => c.column === column.name)
                        return (
                          <tr key={column.key}>
                            <td style={{ paddingLeft: 4 }}>
                              <label className="checkline" style={{ width: '100%' }}>
                                <input
                                  type="checkbox"
                                  checked={Boolean(entry)}
                                  onChange={(e) =>
                                    patchFk(activeFk.key, {
                                      columns: e.target.checked
                                        ? [
                                            ...activeFk.columns,
                                            { column: column.name, referencedColumn: '' }
                                          ]
                                        : activeFk.columns.filter((c) => c.column !== column.name)
                                    })
                                  }
                                />
                                {column.name}
                              </label>
                            </td>
                            <td>
                              {entry && (
                                <select
                                  style={{ width: '100%', height: 18, border: 0, background: 'transparent' }}
                                  value={entry.referencedColumn}
                                  onChange={(e) =>
                                    patchFk(activeFk.key, {
                                      columns: activeFk.columns.map((c) =>
                                        c.column === column.name
                                          ? { ...c, referencedColumn: e.target.value }
                                          : c
                                      )
                                    })
                                  }
                                >
                                  <option value="">(select)</option>
                                  {referencedColumns.map((c) => (
                                    <option key={c} value={c}>
                                      {c}
                                    </option>
                                  ))}
                                </select>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                ) : (
                  <div className="grid-placeholder">Select a foreign key.</div>
                )}
              </div>
            </div>

            <div
              className="col"
              style={{ width: 240, borderLeft: '1px solid var(--border)', padding: 8, gap: 6 }}
            >
              <span className="pane-title">Foreign Key Options</span>
              {activeFk && (
                <div className="form-grid" style={{ gridTemplateColumns: 'max-content 1fr' }}>
                  <label>On Update:</label>
                  <select
                    className="field"
                    value={activeFk.onUpdate}
                    onChange={(e) => patchFk(activeFk.key, { onUpdate: e.target.value })}
                  >
                    {FK_ACTIONS.map((a) => (
                      <option key={a} value={a}>
                        {a || '(default)'}
                      </option>
                    ))}
                  </select>
                  <label>On Delete:</label>
                  <select
                    className="field"
                    value={activeFk.onDelete}
                    onChange={(e) => patchFk(activeFk.key, { onDelete: e.target.value })}
                  >
                    {FK_ACTIONS.map((a) => (
                      <option key={a} value={a}>
                        {a || '(default)'}
                      </option>
                    ))}
                  </select>
                  <label />
                  <label className="checkline">
                    <input
                      type="checkbox"
                      checked={activeFk.skip}
                      onChange={(e) => patchFk(activeFk.key, { skip: e.target.checked })}
                    />
                    Skip in SQL generation
                  </label>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="designer-tabs">
        {(
          [
            ['columns', 'Columns'],
            ['indexes', 'Indexes'],
            ['foreignKeys', 'Foreign Keys']
          ] as [DesignerState['activeSection'], string][]
        ).map(([section, label]) => (
          <div
            key={section}
            className={`designer-tab${state.activeSection === section ? ' active' : ''}`}
            onClick={() => patch({ activeSection: section })}
          >
            {label}
          </div>
        ))}
        <div className="spacer" />
        <span
          className="hint"
          style={{ padding: '0 10px', display: 'flex', alignItems: 'center' }}
          title={sql}
        >
          {state.mode === 'create' ? 'CREATE TABLE' : 'ALTER TABLE'} · Apply opens the SQL in a new
          tab
        </span>
        <button className="toolbar-btn" style={{ height: 22 }} onClick={revert}>
          Revert
        </button>
        <button
          className="toolbar-btn"
          style={{ height: 22, fontWeight: 600 }}
          onClick={() => onApply(sql)}
        >
          Apply
        </button>
      </div>
    </div>
  )
}
