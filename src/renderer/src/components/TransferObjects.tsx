import { useEffect, useMemo, useRef, useState } from 'react'
import type { SchemaInfo } from '@shared/types'
import { isSystemSchema } from '../lib/systemSchemas'
import { RefreshIcon, SchemaIcon, SearchIcon, TableIcon, ViewIcon } from './ui/Icons'

interface Props {
  schemas: SchemaInfo[]
  /** Ticked tables per schema; a schema absent from the map is not exported. */
  selection: Record<string, string[]>
  onChange(selection: Record<string, string[]>): void
  showSystem: boolean
  onShowSystem(next: boolean): void
  loading: boolean
  onRefresh(): void
  canRefresh: boolean
  disabled: boolean
}

/** A checkbox that can also show "some of the children are ticked". */
function TriCheck({
  checked,
  indeterminate,
  disabled,
  onChange
}: {
  checked: boolean
  indeterminate: boolean
  disabled: boolean
  onChange(next: boolean): void
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked
  }, [indeterminate, checked])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
}

/**
 * The schema/table picker shared by both export tabs. The selection is stored as
 * "ticked tables per schema" rather than as a flat list, because that is exactly
 * what the dump tools need: a schema key with every table under it is a whole
 * database, and a key with none is a schema included for its routines alone.
 */
export function TransferObjects({
  schemas,
  selection,
  onChange,
  showSystem,
  onShowSystem,
  loading,
  onRefresh,
  canRefresh,
  disabled
}: Props): JSX.Element {
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const listed = useMemo(
    () => (showSystem ? schemas : schemas.filter((s) => !isSystemSchema(s.name))),
    [schemas, showSystem]
  )
  const systemCount = schemas.length - listed.length

  const needle = filter.trim().toLowerCase()
  const visible = useMemo(() => {
    if (!needle) return listed
    return listed
      .map((schema) => {
        if (schema.name.toLowerCase().includes(needle)) return schema
        const tables = schema.tables.filter((t) => t.name.toLowerCase().includes(needle))
        return tables.length > 0 ? { ...schema, tables } : null
      })
      .filter((s): s is SchemaInfo => s !== null)
  }, [listed, needle])

  const totals = useMemo(() => {
    let tables = 0
    for (const tickedTables of Object.values(selection)) tables += tickedTables.length
    // A schema can be ticked and then hidden. The command would still dump it,
    // so the count says so rather than letting the list quietly disagree.
    const hidden = showSystem ? 0 : Object.keys(selection).filter(isSystemSchema).length
    return { schemas: Object.keys(selection).length, tables, hidden }
  }, [selection, showSystem])

  const setSchema = (schema: SchemaInfo, checked: boolean): void => {
    const next = { ...selection }
    if (checked) next[schema.name] = schema.tables.map((t) => t.name)
    else delete next[schema.name]
    onChange(next)
  }

  const setTable = (schema: SchemaInfo, table: string, checked: boolean): void => {
    const current = selection[schema.name] ?? []
    const next = { ...selection }
    if (checked) {
      next[schema.name] = [...current, table]
    } else {
      const remaining = current.filter((t) => t !== table)
      // Unticking the last table leaves the schema itself ticked, which is how
      // a routines-only dump is expressed; untick the schema to drop it.
      next[schema.name] = remaining
    }
    onChange(next)
  }

  /** Acts on what the filter is showing, leaving anything hidden as it was. */
  const selectAll = (all: boolean): void => {
    const next = needle ? { ...selection } : {}
    for (const schema of visible) {
      if (all) next[schema.name] = schema.tables.map((t) => t.name)
      else delete next[schema.name]
    }
    onChange(next)
  }

  return (
    <>
      <div className="sidebar-head">
        <SearchIcon />
        <input
          className="filter-input"
          placeholder="Filter objects"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          className="icon-btn"
          title={canRefresh ? 'Refresh schemas and tables' : 'Connect to refresh the object list'}
          disabled={!canRefresh || loading}
          onClick={onRefresh}
        >
          <RefreshIcon />
        </button>
      </div>

      <div className="transfer-objects-head">
        <button className="link-btn" disabled={disabled} onClick={() => selectAll(true)}>
          Select all
        </button>
        <button className="link-btn" disabled={disabled} onClick={() => selectAll(false)}>
          Select none
        </button>
        <span className="spacer" />
        <span className="hint">
          {totals.schemas} schema{totals.schemas === 1 ? '' : 's'} · {totals.tables} table
          {totals.tables === 1 ? '' : 's'}
          {totals.hidden > 0 && ` · ${totals.hidden} hidden`}
        </span>
      </div>

      <div className="tree transfer-objects">
        {visible.length === 0 ? (
          <div className="tree-empty">
            {loading
              ? 'Loading schemas…'
              : schemas.length === 0
                ? 'No schemas cached for this connection yet. Connect and refresh.'
                : listed.length === 0
                  ? 'This server has only its own schemas.'
                  : `Nothing matches “${filter}”.`}
          </div>
        ) : (
          visible.map((schema) => {
            const ticked = selection[schema.name]
            const isOpen = !!expanded[schema.name] || (needle !== '' && schema.tables.length > 0)
            const tickedSet = new Set(ticked ?? [])
            const allTicked =
              ticked !== undefined && schema.tables.every((t) => tickedSet.has(t.name))

            return (
              <div key={schema.name}>
                <div
                  className="tree-node"
                  onClick={() => setExpanded((e) => ({ ...e, [schema.name]: !isOpen }))}
                >
                  <span className="tree-twisty">{isOpen ? '▼' : '▶'}</span>
                  <TriCheck
                    checked={allTicked}
                    indeterminate={ticked !== undefined}
                    disabled={disabled}
                    onChange={(next) => setSchema(schema, next)}
                  />
                  <span className="tree-icon">
                    <SchemaIcon />
                  </span>
                  <span
                    className={`tree-label${
                      isSystemSchema(schema.name) ? ' system-schema' : ''
                    }`}
                  >
                    {schema.name}
                  </span>
                  <span className="hint" style={{ marginLeft: 6 }}>
                    {ticked ? `${ticked.length}/${schema.tables.length}` : schema.tables.length}
                  </span>
                </div>

                {isOpen &&
                  schema.tables.map((table) => (
                    <div
                      key={table.name}
                      className="tree-node"
                      style={{ paddingLeft: 18 }}
                      onClick={() => setTable(schema, table.name, !tickedSet.has(table.name))}
                    >
                      <span className="tree-twisty" />
                      <TriCheck
                        checked={tickedSet.has(table.name)}
                        indeterminate={false}
                        disabled={disabled}
                        onChange={(next) => setTable(schema, table.name, next)}
                      />
                      <span className="tree-icon">
                        {table.type === 'view' ? <ViewIcon /> : <TableIcon />}
                      </span>
                      <span className="tree-label">{table.name}</span>
                    </div>
                  ))}
              </div>
            )
          })
        )}

        {(systemCount > 0 || showSystem) && (
          <button
            className="link-btn tree-footer"
            onClick={() => onShowSystem(!showSystem)}
            title="information_schema and performance_schema cannot be dumped at all; mysql and sys only matter when moving accounts or time zones between servers"
          >
            {showSystem ? 'Hide the server’s own schemas' : `Show ${systemCount} system schemas`}
          </button>
        )}
      </div>
    </>
  )
}
