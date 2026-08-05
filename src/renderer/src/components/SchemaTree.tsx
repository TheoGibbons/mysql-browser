import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConnTab } from '../store'
import { useAppStore } from '../store'
import { useContextMenu, type MenuEntry } from './ui/ContextMenu'
import {
  ColumnIcon,
  QueryIcon,
  RefreshIcon,
  SchemaIcon,
  SearchIcon,
  SettingsIcon,
  TableIcon,
  ViewIcon
} from './ui/Icons'
import { dialectFor, qualify } from '@shared/dialect'
import * as T from '../lib/sqlTemplates'
import { designerFromDefinition, emptyDesigner } from '../lib/designer'

const ROW_HEIGHT = 19
/** Extra rows rendered above and below the viewport to keep scrolling smooth. */
const OVERSCAN = 12

type Node =
  | { kind: 'schema'; key: string; name: string; level: 0; expandable: true; expanded: boolean }
  | {
      kind: 'table'
      key: string
      schema: string
      name: string
      tableType: 'table' | 'view'
      level: 1
      expandable: boolean
      expanded: boolean
    }
  | { kind: 'column'; key: string; schema: string; table: string; name: string; level: 2 }

interface Props {
  conn: ConnTab
  /** Opens a tab; `run` is only ever true for read-only SQL. */
  openTab(options: { title?: string; sql?: string; run?: boolean; designer?: any; kind?: any }): void
}

export function SchemaTree({ conn, openTab }: Props): JSX.Element {
  const {
    sessionId,
    schemas,
    filter,
    expanded,
    columnsCache,
    activeSchema,
    selectedNode,
    schemasLoading,
    status
  } = conn

  const setSchemaFilter = useAppStore((s) => s.setSchemaFilter)
  const toggleExpanded = useAppStore((s) => s.toggleExpanded)
  const refreshSchemas = useAppStore((s) => s.refreshSchemas)
  const loadSchemaColumns = useAppStore((s) => s.loadSchemaColumns)
  const setSelectedNode = useAppStore((s) => s.setSelectedNode)
  const setActiveSchema = useAppStore((s) => s.setActiveSchema)
  const runQuery = useAppStore((s) => s.runQuery)

  const engine = conn.config.engine
  const d = dialectFor(engine)

  const menu = useContextMenu()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(400)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight))
    observer.observe(el)
    setViewportHeight(el.clientHeight)
    return () => observer.disconnect()
  }, [])

  const needle = filter.trim().toLowerCase()

  const nodes = useMemo<Node[]>(() => {
    const out: Node[] = []

    for (const schema of schemas) {
      const schemaMatches = needle === '' || schema.name.toLowerCase().includes(needle)
      const matchingTables = needle
        ? schema.tables.filter(
            (t) => schemaMatches || t.name.toLowerCase().includes(needle)
          )
        : schema.tables

      if (needle && !schemaMatches && matchingTables.length === 0) continue

      // A filter auto-expands so matches are visible without extra clicks.
      const isExpanded = needle ? true : !!expanded[schema.name]
      out.push({
        kind: 'schema',
        key: schema.name,
        name: schema.name,
        level: 0,
        expandable: true,
        expanded: isExpanded
      })
      if (!isExpanded) continue

      for (const table of matchingTables) {
        const tableKey = `${schema.name}.${table.name}`
        const columns = columnsCache[tableKey]
        const tableExpanded = !!expanded[tableKey]
        out.push({
          kind: 'table',
          key: tableKey,
          schema: schema.name,
          name: table.name,
          tableType: table.type,
          level: 1,
          expandable: true,
          expanded: tableExpanded
        })
        if (tableExpanded && columns) {
          for (const column of columns) {
            out.push({
              kind: 'column',
              key: `${tableKey}.${column}`,
              schema: schema.name,
              table: table.name,
              name: column,
              level: 2
            })
          }
        }
      }
    }

    return out
  }, [schemas, needle, expanded, columnsCache])

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2
  const slice = nodes.slice(first, first + visibleCount)

  /** Column names for a table, fetching the whole schema's columns if needed. */
  const columnsFor = useCallback(
    async (schema: string, table: string): Promise<string[]> => {
      const cached = columnsCache[`${schema}.${table}`]
      if (cached) return cached
      if (status !== 'connected') return []
      try {
        return await window.api.session.tableColumns(sessionId, schema, table)
      } catch {
        return []
      }
    },
    [columnsCache, sessionId, status]
  )

  const copy = (text: string): void => void window.api.clipboard.write(text)

  const openAlterTable = useCallback(
    async (schema: string, table: string) => {
      if (status !== 'connected') return
      try {
        const definition = await window.api.session.tableDefinition(sessionId, schema, table)
        openTab({
          title: `${table} — Alter`,
          kind: 'designer',
          designer: designerFromDefinition(definition, engine)
        })
      } catch (err) {
        useAppStore.getState().pushHistory(sessionId, {
          status: 'error',
          startedAt: Date.now(),
          action: `Alter table ${schema}.${table}`,
          message: (err as Error).message,
          durationMs: null,
          fetchMs: null
        })
      }
    },
    [openTab, sessionId, status]
  )

  const selectRows = useCallback(
    (schema: string, table: string) => {
      // Read-only, so it may run straight away.
      openTab({ title: table, sql: T.selectRows(d, schema, table), run: true })
    },
    [openTab, d]
  )

  /** `USE x` on MySQL, `SET search_path TO x` on Postgres. */
  const switchSchema = (schema: string): void => {
    setActiveSchema(sessionId, schema)
    const tabId = conn.activeTabId
    if (!tabId) return
    void runQuery(sessionId, tabId, `${d.useSchema(schema)};`, {
      label: `${d.useSchema(schema)}`
    })
  }

  const schemaMenu = (schema: string): MenuEntry[] => [
    { label: 'Set as Default Schema', onSelect: () => switchSchema(schema) },
    { separator: true },
    {
      label: 'Copy to clipboard: name',
      onSelect: () => copy(schema)
    },
    {
      label: 'Copy to clipboard: create statement',
      onSelect: async () => {
        if (status === 'connected') {
          try {
            copy(await window.api.session.createStatement(sessionId, 'schema', schema))
            return
          } catch {
            /* fall through to the template */
          }
        }
        copy(T.createSchema(d, schema))
      }
    },
    { separator: true },
    { label: 'Create schema…', onSelect: () => openTab({ title: 'Create schema', sql: T.createSchema(d) }) },
    {
      label: 'Alter schema…',
      onSelect: () => openTab({ title: `Alter ${schema}`, sql: T.alterSchema(d, schema) })
    },
    {
      label: 'Drop schema…',
      onSelect: () => openTab({ title: `Drop ${schema}`, sql: T.dropSchema(d, schema) })
    },
    { separator: true },
    { label: 'Refresh', onSelect: () => void refreshSchemas(sessionId, true) }
  ]

  const tableMenu = (schema: string, table: string): MenuEntry[] => [
    { label: 'Select Rows - Limit 1000', onSelect: () => selectRows(schema, table) },
    { separator: true },
    {
      label: 'Copy to Clipboard',
      submenu: [
        { label: 'Name (short)', onSelect: () => copy(table) },
        { label: 'Name (long)', onSelect: () => copy(`${schema}.${table}`) },
        { separator: true },
        {
          label: 'Insert into statement',
          onSelect: async () => copy(T.insertIntoTemplate(d, schema, table, await columnsFor(schema, table)))
        },
        {
          label: 'Insert set statement',
          onSelect: async () => copy(T.insertSetTemplate(d, schema, table, await columnsFor(schema, table)))
        },
        {
          label: 'Update statement',
          onSelect: async () => copy(T.updateTemplate(d, schema, table, await columnsFor(schema, table)))
        },
        {
          label: 'Delete statement',
          onSelect: async () => copy(T.deleteTemplate(d, schema, table, await columnsFor(schema, table)))
        },
        { separator: true },
        {
          label: 'Create statement',
          onSelect: async () => {
            if (status !== 'connected') return
            try {
              copy(await window.api.session.createStatement(sessionId, 'table', schema, table))
            } catch {
              /* nothing to copy */
            }
          },
          disabled: status !== 'connected'
        }
      ]
    },
    { separator: true },
    {
      label: 'Create Table…',
      onSelect: () =>
        openTab({ title: 'New table', kind: 'designer', designer: emptyDesigner(schema, engine) })
    },
    {
      label: 'Alter Table…',
      onSelect: () => void openAlterTable(schema, table),
      disabled: status !== 'connected'
    },
    {
      label: 'Drop Table…',
      onSelect: () => openTab({ title: `Drop ${table}`, sql: T.dropTable(d, schema, table) })
    },
    {
      label: 'Truncate Table…',
      onSelect: () => openTab({ title: `Truncate ${table}`, sql: T.truncateTable(d, schema, table) })
    },
    { separator: true },
    { label: 'Refresh', onSelect: () => void refreshSchemas(sessionId, true) }
  ]

  const columnMenu = (schema: string, table: string, column: string): MenuEntry[] => [
    { label: 'Copy column name', onSelect: () => copy(column) },
    {
      label: 'Copy qualified name',
      onSelect: () => copy(`${qualify(d, schema, table)}.${d.quoteIdent(column)}`)
    },
    { separator: true },
    {
      label: `SELECT ${column} FROM ${table}`,
      onSelect: () =>
        openTab({
          title: table,
          sql: `SELECT ${d.quoteIdent(column)} FROM ${qualify(d, schema, table)} LIMIT 1000;`,
          run: true
        })
    }
  ]

  const onNodeClick = (node: Node): void => {
    setSelectedNode(sessionId, node.key)
    if (node.kind === 'schema') {
      toggleExpanded(sessionId, node.key)
      void loadSchemaColumns(sessionId, node.name)
    } else if (node.kind === 'table') {
      toggleExpanded(sessionId, node.key)
      void loadSchemaColumns(sessionId, node.schema)
    }
  }

  const onNodeDoubleClick = (node: Node): void => {
    if (node.kind === 'schema') {
      // Non-modifying, so it runs immediately.
      switchSchema(node.name)
    } else if (node.kind === 'table') {
      selectRows(node.schema, node.name)
    }
  }

  return (
    <>
      <div className="sidebar-head">
        <SearchIcon />
        <input
          className="filter-input"
          placeholder="Filter objects"
          value={filter}
          onChange={(e) => setSchemaFilter(sessionId, e.target.value)}
        />
        <button
          className="icon-btn"
          title="Refresh schemas and tables"
          disabled={status !== 'connected' || schemasLoading}
          onClick={() => void refreshSchemas(sessionId, true)}
        >
          <RefreshIcon />
        </button>
      </div>

      <div
        className="tree"
        ref={scrollRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        {nodes.length === 0 ? (
          <div className="tree-empty">
            {schemasLoading
              ? 'Loading schemas…'
              : schemas.length === 0
                ? status === 'connected'
                  ? 'No schemas found.'
                  : 'Not connected. Cached schemas will appear here once this connection has been opened online at least once.'
                : `Nothing matches “${filter}”.`}
          </div>
        ) : (
          <div style={{ height: nodes.length * ROW_HEIGHT, position: 'relative' }}>
            <div style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
              {slice.map((node) => (
                <div
                  key={node.key}
                  className={`tree-node${selectedNode === node.key ? ' selected' : ''}`}
                  style={{ paddingLeft: 2 + node.level * 14 }}
                  onClick={() => onNodeClick(node)}
                  onDoubleClick={() => onNodeDoubleClick(node)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setSelectedNode(sessionId, node.key)
                    if (node.kind === 'schema') menu.show(e, schemaMenu(node.name))
                    else if (node.kind === 'table') menu.show(e, tableMenu(node.schema, node.name))
                    else menu.show(e, columnMenu(node.schema, node.table, node.name))
                  }}
                  title={node.kind === 'column' ? node.name : node.key}
                >
                  <span className="tree-twisty">
                    {node.kind !== 'column' ? (node.expanded ? '▼' : '▶') : ''}
                  </span>
                  <span className="tree-icon">
                    {node.kind === 'schema' ? (
                      <SchemaIcon />
                    ) : node.kind === 'table' ? (
                      node.tableType === 'view' ? (
                        <ViewIcon />
                      ) : (
                        <TableIcon />
                      )
                    ) : (
                      <ColumnIcon />
                    )}
                  </span>
                  <span
                    className={`tree-label${node.kind === 'column' ? ' dim' : ''}`}
                    style={
                      node.kind === 'schema' && node.name === activeSchema
                        ? { fontWeight: 700 }
                        : undefined
                    }
                  >
                    {node.name}
                  </span>

                  {node.kind === 'table' && (
                    <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="icon-btn"
                        title="Alter table"
                        disabled={status !== 'connected'}
                        onClick={() => void openAlterTable(node.schema, node.name)}
                      >
                        <SettingsIcon />
                      </button>
                      <button
                        className="icon-btn"
                        title="Select rows - limit 1000"
                        onClick={() => selectRows(node.schema, node.name)}
                      >
                        <QueryIcon />
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
