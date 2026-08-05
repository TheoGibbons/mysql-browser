import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CellValue, ResultSet } from '@shared/types'
import { displayValue } from '@shared/sql'
import type { Dialect } from '@shared/dialect'
import {
  addedIndex,
  applySelection,
  cellValue,
  cycleSort,
  editKey,
  isAdded,
  isCellDirty,
  parsePastedRows,
  rowsToInsert,
  rowsToInsertSet,
  rowsToUpdate,
  rowsToValuesText,
  rowsWithNamesText,
  visibleRefs,
  type GridState,
  type RowRef
} from '../lib/grid'
import { useContextMenu, type MenuEntry } from './ui/ContextMenu'

const ROW_HEIGHT = 21
const OVERSCAN = 15
const GUTTER_WIDTH = 26
const MIN_COL_WIDTH = 44
const MAX_DEFAULT_COL_WIDTH = 360

interface Props {
  result: ResultSet
  state: GridState
  patch(patch: Partial<GridState>): void
  update(fn: (state: GridState) => GridState): void
  /** Null when the grid is read-only (no single source table / no key). */
  editable: boolean
  /** Quoting and escaping rules for the connection these rows came from. */
  dialect: Dialect
}

/** Sizes columns from the widest of the header and the first rows of data. */
function defaultWidths(result: ResultSet): Record<number, number> {
  const widths: Record<number, number> = {}
  const sampleSize = Math.min(result.rows.length, 60)

  result.columns.forEach((column, index) => {
    let longest = column.name.length
    for (let r = 0; r < sampleSize; r++) {
      const value = result.rows[r]?.[index]
      const length = value === null ? 4 : String(value).length
      if (length > longest) longest = length
    }
    // ~6.6px per monospace character at 11px, plus padding.
    widths[index] = Math.min(MAX_DEFAULT_COL_WIDTH, Math.max(MIN_COL_WIDTH, longest * 6.6 + 14))
  })

  return widths
}

export function ResultsGrid({
  result,
  state,
  patch,
  update,
  editable,
  dialect: d
}: Props): JSX.Element {
  const menu = useContextMenu()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(300)
  const [editing, setEditing] = useState<{ ref: RowRef; col: number; draft: string } | null>(null)
  const resizeRef = useRef<{ col: number; startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight))
    observer.observe(el)
    setViewportHeight(el.clientHeight)
    return () => observer.disconnect()
  }, [])

  // Reset the scroll position when a new result set arrives.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
    setScrollTop(0)
    setEditing(null)
  }, [result])

  const widths = useMemo(() => {
    const computed = defaultWidths(result)
    return { ...computed, ...state.columnWidths }
  }, [result, state.columnWidths])

  const refs = useMemo(() => visibleRefs(result, state), [result, state])

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const count = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2
  const slice = refs.slice(first, first + count)
  const topPad = first * ROW_HEIGHT
  const bottomPad = Math.max(0, (refs.length - first - slice.length) * ROW_HEIGHT)

  const copy = (text: string): void => void window.api.clipboard.write(text)

  // --- column resizing ----------------------------------------------------

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      const resize = resizeRef.current
      if (!resize) return
      const next = Math.max(MIN_COL_WIDTH, resize.startWidth + (e.clientX - resize.startX))
      patch({ columnWidths: { ...state.columnWidths, [resize.col]: Math.round(next) } })
    }
    const up = (): void => {
      resizeRef.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [patch, state.columnWidths])

  // --- selection ----------------------------------------------------------

  const selectRow = useCallback(
    (ref: RowRef, e: React.MouseEvent) => {
      const next = applySelection(refs, state, ref, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
      patch(next)
    },
    [refs, state, patch]
  )

  const selectedRefs = useMemo(
    () => (state.selection.length > 0 ? state.selection : []),
    [state.selection]
  )

  // --- editing ------------------------------------------------------------

  const commitEdit = useCallback(() => {
    if (!editing) return
    const { ref, col, draft } = editing
    setEditing(null)

    const original = isAdded(ref) ? null : result.rows[ref]?.[col]
    const value: CellValue = draft
    if (!isAdded(ref) && original !== null && String(original) === draft) return
    if (!isAdded(ref) && original === null && draft === 'NULL') return

    update((current) => {
      if (isAdded(ref)) {
        const added = current.added.map((row, i) =>
          i === addedIndex(ref) ? row.map((v, c) => (c === col ? value : v)) : row
        )
        return { ...current, added }
      }
      return { ...current, edits: { ...current.edits, [editKey(ref, col)]: value } }
    })
  }, [editing, result, update])

  const setNull = useCallback(
    (targets: { ref: RowRef; col: number }[]) => {
      update((current) => {
        let added = current.added
        const edits = { ...current.edits }
        for (const { ref, col } of targets) {
          if (isAdded(ref)) {
            added = added.map((row, i) =>
              i === addedIndex(ref) ? row.map((v, c) => (c === col ? null : v)) : row
            )
          } else {
            edits[editKey(ref, col)] = null
          }
        }
        return { ...current, edits, added }
      })
    },
    [update]
  )

  const deleteRows = useCallback(
    (targets: RowRef[]) => {
      update((current) => {
        const deleted = { ...current.deleted }
        const addedToRemove = new Set<number>()
        for (const ref of targets) {
          if (isAdded(ref)) addedToRemove.add(addedIndex(ref))
          else deleted[ref] = true
        }
        const added = current.added.filter((_, i) => !addedToRemove.has(i))
        return { ...current, deleted, added, selection: [], anchor: null }
      })
    },
    [update]
  )

  const pasteRows = useCallback(async () => {
    const text = await window.api.clipboard.read()
    const rows = parsePastedRows(text, result.columns.length)
    if (!rows) {
      window.alert(
        `Clipboard does not contain ${result.columns.length} column(s) per row, so it cannot be pasted into this grid.`
      )
      return
    }
    update((current) => ({ ...current, added: [...current.added, ...rows] }))
  }, [result.columns.length, update])

  // --- context menus ------------------------------------------------------

  const headerMenu = (col: number): MenuEntry[] => [
    { label: 'Copy column name', onSelect: () => copy(result.columns[col].name) },
    {
      label: 'Copy all column names',
      onSelect: () => copy(result.columns.map((c) => c.name).join(', '))
    },
    { separator: true },
    {
      label: 'Copy all column names (quoted)',
      onSelect: () => copy(result.columns.map((c) => d.quoteIdent(c.name)).join(', '))
    },
    { separator: true },
    {
      label: state.sort?.col === col && state.sort.dir === 'asc' ? 'Sort descending' : 'Sort ascending',
      onSelect: () => patch({ sort: cycleSort(state.sort, col) })
    },
    { label: 'Clear sort', onSelect: () => patch({ sort: null }), disabled: !state.sort }
  ]

  const rowMenu = (ref: RowRef, col: number | null): MenuEntry[] => {
    // Right-clicking outside the selection acts on the row under the cursor.
    const targets = state.selection.includes(ref) ? state.selection : [ref]
    const ordered = refs.filter((r) => targets.includes(r))
    const label = ordered.length > 1 ? `${ordered.length} rows` : 'row'

    return [
      {
        label: 'Set Field to NULL',
        disabled: col === null || !editable,
        onSelect: () => col !== null && setNull(ordered.map((r) => ({ ref: r, col })))
      },
      {
        label: `Delete ${label}`,
        disabled: !editable,
        onSelect: () => deleteRows(ordered)
      },
      { separator: true },
      {
        label: 'Copy to Clipboard',
        submenu: [
          { label: 'Copy Row Values', onSelect: () => copy(rowsToValuesText(d, result, state, ordered)) },
          {
            label: 'Copy Row With Names',
            onSelect: () => copy(rowsWithNamesText(d, result, state, ordered))
          },
          { separator: true },
          {
            label: 'Copy Insert Into Statement',
            onSelect: () => copy(rowsToInsert(d, result, state, ordered))
          },
          {
            label: 'Copy Insert Set Statement',
            onSelect: () => copy(rowsToInsertSet(d, result, state, ordered))
          },
          { label: 'Copy Update Statement', onSelect: () => copy(rowsToUpdate(d, result, state, ordered)) },
          { separator: true },
          {
            label: 'Copy Field Value',
            disabled: col === null,
            onSelect: () => col !== null && copy(displayValue(cellValue(result, state, ref, col)))
          }
        ]
      },
      {
        label: 'Paste Row',
        disabled: !editable,
        onSelect: () => void pasteRows()
      },
      { separator: true },
      {
        label: 'Edit Field',
        disabled: col === null || !editable,
        onSelect: () =>
          col !== null &&
          setEditing({ ref, col, draft: displayValue(cellValue(result, state, ref, col)) })
      }
    ]
  }

  // --- render -------------------------------------------------------------

  if (result.columns.length === 0) {
    return (
      <div className="grid-wrap">
        <div className="grid-placeholder">
          {result.message}
          {result.affectedRows > 0 && ' — this statement did not return a result set.'}
        </div>
      </div>
    )
  }

  const totalWidth =
    GUTTER_WIDTH + result.columns.reduce((sum, _c, index) => sum + (widths[index] ?? 120), 0)

  return (
    <div
      className="grid-wrap"
      ref={scrollRef}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
    >
      <table className="grid" style={{ width: totalWidth }}>
        <colgroup>
          <col style={{ width: GUTTER_WIDTH }} />
          {result.columns.map((_c, index) => (
            <col key={index} style={{ width: widths[index] ?? 120 }} />
          ))}
          {/* Soaks up any width left over when the pane is wider than the columns,
              so the fixed layout doesn't stretch the gutter and data columns. */}
          <col />
        </colgroup>

        <thead>
          <tr>
            <th className="gutter" title={`${refs.length} row(s)`} />
            {result.columns.map((column, index) => (
              <th
                key={index}
                style={{ position: 'sticky', top: 0 }}
                title={`${column.name}${column.orgTable ? ` — ${column.orgTable}` : ''} (${column.typeName})${
                  column.isPrimaryKey ? ' · PK' : ''
                }`}
                onClick={() => patch({ sort: cycleSort(state.sort, index) })}
                onContextMenu={(e) => {
                  e.preventDefault()
                  menu.show(e, headerMenu(index))
                }}
              >
                {column.isPrimaryKey && <span style={{ color: '#d1a318', marginRight: 3 }}>🔑</span>}
                {column.name}
                {state.sort?.col === index && (
                  <span className="sort-arrow">{state.sort.dir === 'asc' ? '▲' : '▼'}</span>
                )}
                <span
                  className="col-resizer"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    resizeRef.current = {
                      col: index,
                      startX: e.clientX,
                      startWidth: widths[index] ?? 120
                    }
                  }}
                />
              </th>
            ))}
            <th className="filler" />
          </tr>
        </thead>

        <tbody>
          {topPad > 0 && (
            <tr style={{ height: topPad }}>
              <td className="gutter" colSpan={result.columns.length + 2} />
            </tr>
          )}

          {slice.map((ref, sliceIndex) => {
            const displayIndex = first + sliceIndex
            const added = isAdded(ref)
            const deleted = !added && !!state.deleted[ref]
            const selected = state.selection.includes(ref)

            return (
              <tr
                key={ref}
                className={[
                  displayIndex % 2 === 1 ? 'odd' : '',
                  selected ? 'selected' : '',
                  deleted ? 'deleted' : '',
                  added ? 'added' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <td
                  className="gutter"
                  onClick={(e) => selectRow(ref, e)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    if (!state.selection.includes(ref)) patch({ selection: [ref], anchor: ref })
                    menu.show(e, rowMenu(ref, null))
                  }}
                  title="Click to select · Shift/Ctrl for multiple"
                >
                  {added ? '+' : selected ? '▸' : ''}
                </td>

                {result.columns.map((column, col) => {
                  const value = cellValue(result, state, ref, col)
                  const isEditing = editing?.ref === ref && editing.col === col
                  const dirty = isCellDirty(state, ref, col)

                  if (isEditing) {
                    return (
                      <td key={col} className="editing">
                        <input
                          autoFocus
                          value={editing.draft}
                          onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                          onBlur={commitEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              commitEdit()
                            } else if (e.key === 'Escape') {
                              e.preventDefault()
                              setEditing(null)
                            }
                          }}
                        />
                      </td>
                    )
                  }

                  return (
                    <td
                      key={col}
                      className={[value === null ? 'null-cell' : '', dirty ? 'dirty' : '']
                        .filter(Boolean)
                        .join(' ')}
                      title={value === null ? 'NULL' : String(value)}
                      onMouseDown={(e) => {
                        // Left-click a cell selects its row without stealing text selection.
                        if (e.button === 0 && e.detail === 1) selectRow(ref, e)
                      }}
                      onDoubleClick={() => {
                        if (!editable || deleted) return
                        setEditing({ ref, col, draft: displayValue(value) })
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        if (!state.selection.includes(ref)) patch({ selection: [ref], anchor: ref })
                        menu.show(e, rowMenu(ref, col))
                      }}
                    >
                      {value === null ? 'NULL' : String(value)}
                    </td>
                  )
                })}
                <td className="filler" />
              </tr>
            )
          })}

          {bottomPad > 0 && (
            <tr style={{ height: bottomPad }}>
              <td className="gutter" colSpan={result.columns.length + 2} />
            </tr>
          )}
        </tbody>
      </table>

      {refs.length === 0 && <div className="grid-placeholder">No rows.</div>}
      {selectedRefs.length > 1 && (
        <div
          style={{
            position: 'sticky',
            bottom: 0,
            left: 0,
            padding: '2px 6px',
            fontSize: 11,
            color: 'var(--text-dim)',
            background: 'rgba(255,255,255,.92)',
            borderTop: '1px solid var(--border-light)',
            width: 'max-content'
          }}
        >
          {selectedRefs.length} rows selected
        </div>
      )}
    </div>
  )
}
