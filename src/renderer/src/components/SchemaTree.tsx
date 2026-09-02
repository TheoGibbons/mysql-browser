import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
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
import { isSystemSchema } from '../lib/systemSchemas'

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

type SchemaNode = Extract<Node, { kind: 'schema' }>
type TableNode = Extract<Node, { kind: 'table' }>
type ColumnNode = Extract<Node, { kind: 'column' }>

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
    selectedNodes,
    selectionAnchor,
    schemasLoading,
    showSystemSchemas,
    status
  } = conn

  const setSchemaFilter = useAppStore((s) => s.setSchemaFilter)
  const toggleExpanded = useAppStore((s) => s.toggleExpanded)
  const refreshSchemas = useAppStore((s) => s.refreshSchemas)
  const loadSchemaColumns = useAppStore((s) => s.loadSchemaColumns)
  const setSelectedNodes = useAppStore((s) => s.setSelectedNodes)
  const setActiveSchema = useAppStore((s) => s.setActiveSchema)
  const setShowSystemSchemas = useAppStore((s) => s.setShowSystemSchemas)
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

  // The server's own schemas are noise for all but one job. The schema in use
  // stays visible either way, so nothing can hide the schema being worked in.
  const listed = useMemo(
    () =>
      showSystemSchemas
        ? schemas
        : schemas.filter((s) => !isSystemSchema(s.name) || s.name === activeSchema),
    [schemas, showSystemSchemas, activeSchema]
  )
  const hiddenCount = schemas.length - listed.length

  const nodes = useMemo<Node[]>(() => {
    const out: Node[] = []

    for (const schema of listed) {
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
  }, [listed, needle, expanded, columnsCache])

  const selectedKeys = useMemo(() => new Set(selectedNodes), [selectedNodes])

  const selectedVisibleNodes = useMemo(
    () => nodes.filter((node) => selectedKeys.has(node.key)),
    [nodes, selectedKeys]
  )

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

  /** One object per line keeps multi-object copies useful in editors and terminals. */
  const copyShortNames = (selection: Node[]): void => {
    if (selection.length === 0) return
    copy(selection.map((item) => item.name).join('\n'))
  }

  /** SQL templates stay separate statements when several relations are selected. */
  const copyTableTemplates = async (
    targets: TableNode[],
    template: (target: TableNode, columns: string[]) => string
  ): Promise<void> => {
    const statements = await Promise.all(
      targets.map(async (target) =>
        template(target, await columnsFor(target.schema, target.name))
      )
    )
    copy(statements.join('\n\n'))
  }

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

  const schemaMenu = (node: SchemaNode, selection: Node[]): MenuEntry[] => {
    const multiple = selection.length > 1
    const targets = selection.filter((item): item is SchemaNode => item.kind === 'schema')
    const compatible = targets.length === selection.length
    const dropSql = T.withForeignKeyChecks(
      d,
      targets.map((item) => T.dropSchema(d, item.name)).join('\n')
    )

    return [
      {
        label: 'Set as Default Schema',
        onSelect: () => switchSchema(node.name),
        disabled: multiple
      },
      { separator: true },
      {
        label: 'Copy to Clipboard',
        disabled: !compatible,
        submenu: [
          {
            label: 'Name (short)',
            onSelect: () => copyShortNames(targets)
          },
          { separator: true },
          {
            label: 'Create statement',
            onSelect: async () => {
              const statements = await Promise.all(
                targets.map(async (target) => {
                  if (status === 'connected') {
                    try {
                      return await window.api.session.createStatement(
                        sessionId,
                        'schema',
                        target.name
                      )
                    } catch {
                      /* fall through to the template */
                    }
                  }
                  return T.createSchema(d, target.name)
                })
              )
              copy(statements.join('\n\n'))
            }
          }
        ]
      },
      { separator: true },
      {
        label: 'Create schema…',
        onSelect: () => openTab({ title: 'Create schema', sql: T.createSchema(d) })
      },
      {
        label: 'Alter schema…',
        onSelect: () => openTab({ title: `Alter ${node.name}`, sql: T.alterSchema(d, node.name) }),
        disabled: multiple
      },
      {
        label: multiple && compatible ? `Drop ${targets.length} Schemas…` : 'Drop schema…',
        onSelect: () =>
          openTab({
            title: multiple ? `Drop ${targets.length} schemas` : `Drop ${node.name}`,
            sql: dropSql
          }),
        disabled: !compatible
      },
      { separator: true },
      { label: 'Refresh', onSelect: () => void refreshSchemas(sessionId, true) }
    ]
  }

  const tableMenu = (node: TableNode, selection: Node[]): MenuEntry[] => {
    const multiple = selection.length > 1
    const targets = selection.filter((item): item is TableNode => item.kind === 'table')
    const compatible = targets.length === selection.length
    const allTables = compatible && targets.every((item) => item.tableType === 'table')
    const allViews = compatible && targets.every((item) => item.tableType === 'view')
    const copyCompatible = allTables || allViews
    const objectName = allTables ? 'Table' : allViews ? 'View' : 'Object'
    const dropSql = T.withForeignKeyChecks(
      d,
      targets
        .map((item) =>
          item.tableType === 'view'
            ? T.dropView(d, item.schema, item.name)
            : T.dropTable(d, item.schema, item.name)
        )
        .join('\n')
    )
    const truncateSql = targets
      .map((item) => T.truncateTable(d, item.schema, item.name))
      .join('\n')

    return [
      {
        label: 'Select Rows - Limit 1000',
        onSelect: () => selectRows(node.schema, node.name),
        disabled: multiple
      },
      { separator: true },
      {
        label: 'Copy to Clipboard',
        disabled: !copyCompatible,
        submenu: [
          { label: 'Name (short)', onSelect: () => copyShortNames(targets) },
          {
            label: 'Name (long)',
            onSelect: () =>
              copy(targets.map((target) => `${target.schema}.${target.name}`).join('\n'))
          },
          { separator: true },
          {
            label: 'Insert into statement',
            onSelect: () =>
              void copyTableTemplates(targets, (target, columns) =>
                T.insertIntoTemplate(d, target.schema, target.name, columns)
              )
          },
          {
            label: 'Insert set statement',
            onSelect: () =>
              void copyTableTemplates(targets, (target, columns) =>
                T.insertSetTemplate(d, target.schema, target.name, columns)
              )
          },
          {
            label: 'Update statement',
            onSelect: () =>
              void copyTableTemplates(targets, (target, columns) =>
                T.updateTemplate(d, target.schema, target.name, columns)
              )
          },
          {
            label: 'Delete statement',
            onSelect: () =>
              void copyTableTemplates(targets, (target, columns) =>
                T.deleteTemplate(d, target.schema, target.name, columns)
              )
          },
          { separator: true },
          {
            label: 'Create statement',
            onSelect: async () => {
              if (status !== 'connected') return
              const statements = await Promise.all(
                targets.map(async (target) => {
                  try {
                    return await window.api.session.createStatement(
                      sessionId,
                      'table',
                      target.schema,
                      target.name
                    )
                  } catch {
                    return ''
                  }
                })
              )
              const available = statements.filter(Boolean)
              if (available.length > 0) copy(available.join('\n\n'))
            },
            disabled: status !== 'connected'
          }
        ]
      },
      { separator: true },
      {
        label: 'Create Table…',
        onSelect: () =>
          openTab({ title: 'New table', kind: 'designer', designer: emptyDesigner(node.schema, engine) })
      },
      {
        label: 'Alter Table…',
        onSelect: () => void openAlterTable(node.schema, node.name),
        disabled: multiple || status !== 'connected'
      },
      {
        label:
          multiple && compatible
            ? `Drop ${targets.length} ${objectName}s…`
            : `Drop ${objectName}…`,
        onSelect: () =>
          openTab({
            title: multiple ? `Drop ${targets.length} ${objectName.toLowerCase()}s` : `Drop ${node.name}`,
            sql: dropSql
          }),
        disabled: !compatible
      },
      {
        label: multiple && allTables ? `Truncate ${targets.length} Tables…` : 'Truncate Table…',
        onSelect: () =>
          openTab({
            title: multiple ? `Truncate ${targets.length} tables` : `Truncate ${node.name}`,
            sql: truncateSql
          }),
        disabled: !allTables
      },
      { separator: true },
      { label: 'Refresh', onSelect: () => void refreshSchemas(sessionId, true) }
    ]
  }

  const columnMenu = (node: ColumnNode, selection: Node[]): MenuEntry[] => {
    const multiple = selection.length > 1
    const targets = selection.filter((item): item is ColumnNode => item.kind === 'column')
    const compatible = targets.length === selection.length

    return [
      {
        label: 'Copy to Clipboard',
        disabled: !compatible,
        submenu: [
          { label: 'Name (short)', onSelect: () => copyShortNames(targets) },
          {
            label: 'Name (qualified)',
            onSelect: () =>
              copy(
                targets
                  .map(
                    (target) =>
                      `${qualify(d, target.schema, target.table)}.${d.quoteIdent(target.name)}`
                  )
                  .join('\n')
              )
          }
        ]
      },
      { separator: true },
      {
        label: `SELECT ${node.name} FROM ${node.table}`,
        onSelect: () =>
          openTab({
            title: node.table,
            sql: `SELECT ${d.quoteIdent(node.name)} FROM ${qualify(d, node.schema, node.table)} LIMIT 1000;`,
            run: true
          }),
        disabled: multiple
      }
    ]
  }

  const onNodeClick = (node: Node, event: ReactMouseEvent<HTMLDivElement>): void => {
    scrollRef.current?.focus({ preventScroll: true })
    const additive = event.ctrlKey || event.metaKey

    if (event.shiftKey) {
      const anchor = selectionAnchor ?? selectedNodes[0] ?? node.key
      const anchorIndex = nodes.findIndex((item) => item.key === anchor)
      const nodeIndex = nodes.findIndex((item) => item.key === node.key)

      if (anchorIndex === -1 || nodeIndex === -1) {
        setSelectedNodes(sessionId, [node.key], node.key)
        return
      }

      const start = Math.min(anchorIndex, nodeIndex)
      const end = Math.max(anchorIndex, nodeIndex)
      const rangeNodes = nodes.slice(start, end + 1)
      // A table range should not accidentally absorb expanded columns (and a
      // schema range should not absorb all of its children).
      const selectedRange =
        nodes[anchorIndex].kind === node.kind
          ? rangeNodes.filter((item) => item.kind === node.kind)
          : rangeNodes
      const range = selectedRange.map((item) => item.key)
      const next = additive ? Array.from(new Set([...selectedNodes, ...range])) : range
      setSelectedNodes(sessionId, next, anchor)
      return
    }

    if (additive) {
      const next = selectedKeys.has(node.key)
        ? selectedNodes.filter((key) => key !== node.key)
        : [...selectedNodes, node.key]
      setSelectedNodes(sessionId, next, node.key)
      return
    }

    setSelectedNodes(sessionId, [node.key], node.key)
    if (node.kind === 'schema') {
      toggleExpanded(sessionId, node.key)
      void loadSchemaColumns(sessionId, node.name)
    } else if (node.kind === 'table') {
      toggleExpanded(sessionId, node.key)
      void loadSchemaColumns(sessionId, node.schema)
    }
  }

  const selectionForContextMenu = (node: Node): Node[] => {
    if (!selectedKeys.has(node.key)) {
      setSelectedNodes(sessionId, [node.key], node.key)
      return [node]
    }
    return selectedVisibleNodes
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
        role="tree"
        tabIndex={0}
        aria-multiselectable="true"
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        onKeyDown={(e) => {
          if (
            (e.ctrlKey || e.metaKey) &&
            !e.altKey &&
            e.key.toLowerCase() === 'c' &&
            selectedVisibleNodes.length > 0
          ) {
            e.preventDefault()
            copyShortNames(selectedVisibleNodes)
          }
        }}
      >
        {nodes.length === 0 ? (
          <div className="tree-empty">
            {schemasLoading
              ? 'Loading schemas…'
              : schemas.length === 0
                ? status === 'connected'
                  ? 'No schemas found.'
                  : 'Not connected. Cached schemas will appear here once this connection has been opened online at least once.'
                : listed.length === 0
                  ? 'This server has only its own schemas.'
                  : `Nothing matches “${filter}”.`}
          </div>
        ) : (
          <div style={{ height: nodes.length * ROW_HEIGHT, position: 'relative' }}>
            <div style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
              {slice.map((node) => (
                <div
                  key={node.key}
                  className={`tree-node${selectedKeys.has(node.key) ? ' selected' : ''}`}
                  style={{ paddingLeft: 2 + node.level * 14 }}
                  role="treeitem"
                  aria-selected={selectedKeys.has(node.key)}
                  onClick={(e) => onNodeClick(node, e)}
                  onDoubleClick={() => onNodeDoubleClick(node)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    scrollRef.current?.focus({ preventScroll: true })
                    const selection = selectionForContextMenu(node)
                    if (node.kind === 'schema') menu.show(e, schemaMenu(node, selection))
                    else if (node.kind === 'table') menu.show(e, tableMenu(node, selection))
                    else menu.show(e, columnMenu(node, selection))
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
                    className={`tree-label${node.kind === 'column' ? ' dim' : ''}${
                      node.kind === 'schema' && isSystemSchema(node.name) ? ' system-schema' : ''
                    }`}
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
                        disabled={selectedNodes.length > 1 || status !== 'connected'}
                        onClick={() => void openAlterTable(node.schema, node.name)}
                      >
                        <SettingsIcon />
                      </button>
                      <button
                        className="icon-btn"
                        title="Select rows - limit 1000"
                        disabled={selectedNodes.length > 1}
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

        {(hiddenCount > 0 || showSystemSchemas) && (
          <button
            className="link-btn tree-footer"
            onClick={() => setShowSystemSchemas(sessionId, !showSystemSchemas)}
            title="information_schema, mysql, performance_schema and sys — the server's own schemas"
          >
            {showSystemSchemas
              ? 'Hide the server’s own schemas'
              : `Show ${hiddenCount} system schemas`}
          </button>
        )}
      </div>
    </>
  )
}
