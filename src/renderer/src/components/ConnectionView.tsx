import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { format as formatSql } from 'sql-formatter'
import type { DesignerState, QueryTabState } from '@shared/types'
import { hasModifyingStatement, statementAt } from '@shared/sql'
import { dialectFor } from '@shared/dialect'
import { engineOf } from '@shared/types'
import { gridKey, useAppStore, useGridStore, type ConnTab, type NewTabOptions } from '../store'
import { buildApplyPlan, isDirty, toCsv, toJson, toSqlInserts, toTsv, visibleRefs } from '../lib/grid'
import { isValidHex, tint } from '../lib/color'
import { SchemaTree } from './SchemaTree'
import { QueryTabsBar } from './QueryTabsBar'
import { QueryEditor, type EditorApi } from './QueryEditor'
import { ResultsGrid } from './ResultsGrid'
import { HistoryView } from './HistoryView'
import { TableDesigner } from './TableDesigner'
import { ExportImportTab } from './ExportImportTab'
import { ApplyChangesModal } from './ApplyChangesModal'
import { ConfirmModifyModal } from './ConfirmModifyModal'
import { PreferencesDialog } from './PreferencesDialog'
import { Splitter } from './ui/Splitter'
import { useContextMenu } from './ui/ContextMenu'
import {
  BoltCursorIcon,
  BoltExplainIcon,
  BoltIcon,
  BroomIcon,
  ExportIcon,
  ImportIcon,
  PlugIcon,
  SettingsIcon,
  StopIcon
} from './ui/Icons'

interface Props {
  conn: ConnTab
}

export function ConnectionView({ conn }: Props): JSX.Element {
  const { sessionId, tabs, activeTabId, running, layout, status } = conn

  const engine = engineOf(conn.config)
  const d = dialectFor(engine)

  const prefs = useAppStore((s) => s.prefs)
  const newTab = useAppStore((s) => s.newTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const closeTabs = useAppStore((s) => s.closeTabs)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const updateTab = useAppStore((s) => s.updateTab)
  const runQuery = useAppStore((s) => s.runQuery)
  const cancelQuery = useAppStore((s) => s.cancelQuery)
  const reconnect = useAppStore((s) => s.reconnect)
  const setLayout = useAppStore((s) => s.setLayout)
  const persistMeta = useAppStore((s) => s.persistMeta)
  const pushHistory = useAppStore((s) => s.pushHistory)

  const gridStates = useGridStore((s) => s.states)
  const patchGrid = useGridStore((s) => s.patch)
  const updateGrid = useGridStore((s) => s.update)
  const resetGrid = useGridStore((s) => s.reset)
  const dropGrid = useGridStore((s) => s.drop)

  const menu = useContextMenu()
  const editorApi = useRef<EditorApi | null>(null)
  const [showPrefs, setShowPrefs] = useState(false)
  const [applyState, setApplyState] = useState<{
    sql: string
    count: number
    busy: boolean
    error: string | null
  } | null>(null)
  const [pendingModify, setPendingModify] = useState<{ sql: string } | null>(null)

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const isRunning = activeTabId ? !!running[activeTabId] : false
  const key = activeTabId ? gridKey(sessionId, activeTabId) : ''
  const grid = gridStates[key]
  const result = activeTab?.result ?? null

  const openTab = useCallback(
    (options: NewTabOptions) => newTab(sessionId, options),
    [newTab, sessionId]
  )

  // --- completion schema --------------------------------------------------

  const completionSchema = useMemo(() => {
    const out: Record<string, Record<string, string[]>> = {}
    for (const schema of conn.schemas) {
      const tables: Record<string, string[]> = {}
      for (const table of schema.tables) {
        tables[table.name] = conn.columnsCache[`${schema.name}.${table.name}`] ?? []
      }
      out[schema.name] = tables
    }
    return out
  }, [conn.schemas, conn.columnsCache])

  // Preload columns for the default schema so completion is useful immediately.
  useEffect(() => {
    if (conn.activeSchema && status === 'connected') {
      void useAppStore.getState().loadSchemaColumns(sessionId, conn.activeSchema)
    }
  }, [conn.activeSchema, sessionId, status])

  // --- execution ----------------------------------------------------------

  const runResolved = useCallback(
    (sql: string, explain: boolean) => {
      if (!activeTabId) return
      // Fresh results invalidate any pending edits on the old ones.
      resetGrid(gridKey(sessionId, activeTabId))
      void runQuery(sessionId, activeTabId, sql, { explain })
    },
    [activeTabId, resetGrid, runQuery, sessionId]
  )

  const execute = useCallback(
    (mode: 'all' | 'current' | 'explain') => {
      if (!activeTab || activeTab.kind !== 'query') return
      const api = editorApi.current
      if (!api) return

      let sql: string | null
      if (mode === 'all') {
        sql = api.getSelection() ?? api.getSql()
      } else {
        sql = api.getStatementAtCursor()
      }
      if (!sql || !sql.trim()) return

      // EXPLAIN never modifies; otherwise, gate modifying SQL behind the loud
      // confirmation when the connection opts in.
      if (mode !== 'explain' && conn.config.confirmModifying && hasModifyingStatement(sql, engine)) {
        setPendingModify({ sql })
        return
      }
      runResolved(sql, mode === 'explain')
    },
    [activeTab, conn.config.confirmModifying, runResolved, engine]
  )

  const prettify = useCallback(() => {
    const api = editorApi.current
    if (!api) return
    const full = api.getSql()
    const statement = api.getStatementAtCursor()
    if (!statement) return
    try {
      const pretty = formatSql(statement, {
        language: engine === 'postgres' ? 'postgresql' : 'mysql',
        keywordCase: 'upper'
      })
      // Replace just the statement under the caret, leaving the rest untouched.
      const found = statementAt(
        full,
        full.indexOf(statement) >= 0 ? full.indexOf(statement) : 0,
        engine
      )
      if (!found) return
      api.setSql(full.slice(0, found.start) + pretty + full.slice(found.end))
    } catch (err) {
      pushHistory(sessionId, {
        status: 'error',
        startedAt: Date.now(),
        action: 'Beautify query',
        message: (err as Error).message,
        durationMs: null,
        fetchMs: null
      })
    }
  }, [pushHistory, sessionId])

  // --- keyboard -----------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.altKey) return
      const lower = e.key.toLowerCase()
      if (lower === 't') {
        e.preventDefault()
        newTab(sessionId)
      } else if (lower === 'w') {
        e.preventDefault()
        if (activeTabId) closeTab(sessionId, activeTabId)
      } else if (lower === 'r' && e.shiftKey) {
        e.preventDefault()
        void reconnect(sessionId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTabId, closeTab, newTab, reconnect, sessionId])

  // Drop grid state for tabs that no longer exist.
  useEffect(() => {
    const live = new Set(tabs.map((t) => gridKey(sessionId, t.id)))
    for (const existing of Object.keys(gridStates)) {
      if (existing.startsWith(`${sessionId}:`) && !live.has(existing)) dropGrid(existing)
    }
  }, [tabs, sessionId, gridStates, dropGrid])

  // --- apply / revert -----------------------------------------------------

  const dirty = grid ? isDirty(grid) : false
  const canEdit = Boolean(result?.editTable && (result?.keyColumns.length ?? 0) > 0)

  const openApplyModal = (): void => {
    if (!result || !grid) return
    const plan = buildApplyPlan(d, result, grid)
    if (plan.blockedReason) {
      window.alert(plan.blockedReason)
      return
    }
    setApplyState({ sql: plan.sql, count: plan.statementCount, busy: false, error: null })
  }

  const confirmApply = async (): Promise<void> => {
    if (!applyState || !activeTabId) return
    setApplyState({ ...applyState, busy: true, error: null })
    try {
      // No label: the History Action column should show the SQL that actually ran.
      await runQuery(sessionId, activeTabId, applyState.sql)
      setApplyState(null)
      resetGrid(gridKey(sessionId, activeTabId))
      // Re-run the original SELECT so the grid reflects what is now stored.
      const statement = activeTab?.resultStatement
      if (statement && /^\s*SELECT/i.test(statement)) {
        await runQuery(sessionId, activeTabId, statement)
      }
    } catch (err) {
      setApplyState((current) =>
        current ? { ...current, busy: false, error: (err as Error).message } : current
      )
    }
  }

  const exportResults = (event: React.MouseEvent): void => {
    if (!result || !grid) return
    const refs = grid.selection.length > 0 ? grid.selection : visibleRefs(result, grid)

    const save = async (
      contents: string,
      extension: string,
      description: string
    ): Promise<void> => {
      const base = (activeTab?.title || 'result').replace(/[^\w.-]+/g, '_')
      const suggested = prefs.exportDirectory
        ? `${prefs.exportDirectory}\\${base}.${extension}`
        : `${base}.${extension}`
      const target = await window.api.dialog.saveFile('Export result set', suggested, [
        { name: description, extensions: [extension] }
      ])
      if (!target) return
      await window.api.files.write(target, contents)
      pushHistory(sessionId, {
        status: 'ok',
        startedAt: Date.now(),
        action: `Export ${refs.length} row(s) to ${extension.toUpperCase()}`,
        message: target,
        durationMs: 0,
        fetchMs: 0
      })
    }

    menu.show(event, [
      { label: `Export ${refs.length} row(s) as CSV…`, onSelect: () => void save(toCsv(result, grid, refs), 'csv', 'CSV') },
      { label: 'Export as TSV…', onSelect: () => void save(toTsv(result, grid, refs), 'tsv', 'TSV') },
      { label: 'Export as JSON…', onSelect: () => void save(toJson(result, grid, refs), 'json', 'JSON') },
      {
        label: 'Export as SQL INSERTs…',
        onSelect: () => void save(toSqlInserts(d, result, grid, refs), 'sql', 'SQL')
      },
      { separator: true },
      {
        label: 'Copy all as CSV',
        onSelect: () => void window.api.clipboard.write(toCsv(result, grid, refs))
      }
    ])
  }

  // --- render -------------------------------------------------------------

  const showResults = Boolean(result) && !isRunning && activeTab?.kind === 'query'

  return (
    <div className="col fill">
      <div className="toolbar">
        <button className="toolbar-btn" onClick={() => setShowPrefs(true)}>
          <SettingsIcon /> Preferences
        </button>
        <button
          className="toolbar-btn"
          onClick={() => openTab({ title: 'Data Export', kind: 'export' })}
        >
          <ExportIcon /> Data Export
        </button>
        <button
          className="toolbar-btn"
          onClick={() => openTab({ title: 'Data Import', kind: 'import' })}
        >
          <ImportIcon /> Data Import
        </button>
        <button
          className="toolbar-btn"
          onClick={() => void reconnect(sessionId)}
          disabled={status === 'connecting'}
          title="Close and re-open every connection for this tab (Ctrl+Shift+R)"
        >
          <PlugIcon /> Reconnect
        </button>
        <div className="toolbar-sep" />
        <span className={`status-dot ${status}`} />
        <span className="status-text" title={conn.statusMessage}>
          {status === 'connected'
            ? `Connected${
                conn.serverVersion
                  ? ` — ${engine === 'postgres' ? 'PostgreSQL' : 'MySQL'} ${conn.serverVersion}`
                  : ''
              }${
                conn.activeSchema ? ` · ${conn.activeSchema}` : ''
              }`
            : status === 'connecting'
              ? 'Connecting…'
              : status === 'error'
                ? `Error: ${conn.statusMessage ?? 'connection failed'}`
                : 'Offline — showing cached schemas and saved tabs'}
        </span>
        {!conn.isPrimary && (
          <span className="status-text" title="Only the first tab for a connection saves its tabs">
            · secondary tab (not auto-saved)
          </span>
        )}
      </div>

      <div className="row fill" style={{ alignItems: 'stretch' }}>
        <div className="sidebar" style={{ width: layout.sidebarWidth }}>
          <SchemaTree conn={conn} openTab={openTab} />
        </div>
        <Splitter
          orientation="vertical"
          size={layout.sidebarWidth}
          grow="before"
          min={150}
          max={700}
          onResize={(width) => setLayout(sessionId, { sidebarWidth: width })}
          onCommit={() => void persistMeta(sessionId)}
        />

        <div className="col fill">
          <QueryTabsBar
            tabs={tabs}
            activeTabId={activeTabId}
            running={running}
            onSelect={(id) => setActiveTab(sessionId, id)}
            onClose={(id) => closeTab(sessionId, id)}
            onCloseMany={(ids) => closeTabs(sessionId, ids)}
            onNewTab={() => newTab(sessionId)}
          />

          {activeTab ? (
            <TabContent
              key={activeTab.id}
              conn={conn}
              tab={activeTab}
              isRunning={isRunning}
              showResults={showResults}
              canEdit={canEdit}
              dirty={dirty}
              completionSchema={completionSchema}
              editorApi={editorApi}
              onSqlChange={(sql) => updateTab(sessionId, activeTab.id, { sql })}
              onDesignerChange={(designer) => updateTab(sessionId, activeTab.id, { designer })}
              onExecute={execute}
              onPrettify={prettify}
              onCancel={() => void cancelQuery(sessionId, activeTab.id)}
              onExport={exportResults}
              onApply={openApplyModal}
              onRevert={() => resetGrid(gridKey(sessionId, activeTab.id))}
              openTab={openTab}
              gridState={grid}
              patchGrid={(patch) => patchGrid(key, patch)}
              updateGrid={(fn) => updateGrid(key, fn)}
              onLayout={(patch) => setLayout(sessionId, patch)}
              onLayoutCommit={() => void persistMeta(sessionId)}
            />
          ) : (
            <div className="placeholder-tab">No tab open. Press Ctrl+T to create one.</div>
          )}

          <Splitter
            orientation="horizontal"
            size={layout.historyHeight}
            grow="after"
            min={60}
            max={600}
            onResize={(height) => setLayout(sessionId, { historyHeight: height })}
            onCommit={() => void persistMeta(sessionId)}
          />
          <div className="pane" style={{ height: layout.historyHeight, flex: 'none' }}>
            <HistoryView
              entries={conn.history}
              widths={layout.historyColumns}
              onResize={(historyColumns) => setLayout(sessionId, { historyColumns })}
              onResizeCommit={() => void persistMeta(sessionId)}
              onUseSql={(sql) => openTab({ sql, title: 'From history' })}
            />
          </div>
        </div>
      </div>

      {showPrefs && (
        <PreferencesDialog connection={conn.config} onClose={() => setShowPrefs(false)} />
      )}

      {applyState && (
        <ApplyChangesModal
          sql={applyState.sql}
          statementCount={applyState.count}
          busy={applyState.busy}
          error={applyState.error}
          onCancel={() => setApplyState(null)}
          onConfirm={() => void confirmApply()}
        />
      )}

      {pendingModify && (
        <ConfirmModifyModal
          sql={pendingModify.sql}
          connectionName={conn.name}
          onCancel={() => setPendingModify(null)}
          onConfirm={() => {
            const sql = pendingModify.sql
            setPendingModify(null)
            runResolved(sql, false)
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

interface TabContentProps {
  conn: ConnTab
  tab: QueryTabState
  isRunning: boolean
  showResults: boolean
  canEdit: boolean
  dirty: boolean
  completionSchema: Record<string, Record<string, string[]>>
  editorApi: React.MutableRefObject<EditorApi | null>
  onSqlChange(sql: string): void
  onDesignerChange(designer: DesignerState): void
  onExecute(mode: 'all' | 'current' | 'explain'): void
  onPrettify(): void
  onCancel(): void
  onExport(event: React.MouseEvent): void
  onApply(): void
  onRevert(): void
  openTab(options: NewTabOptions): string
  gridState: ReturnType<typeof useGridStore.getState>['states'][string] | undefined
  patchGrid(patch: any): void
  updateGrid(fn: any): void
  onLayout(patch: { resultsHeight?: number }): void
  onLayoutCommit(): void
}

function TabContent({
  conn,
  tab,
  isRunning,
  showResults,
  canEdit,
  dirty,
  completionSchema,
  editorApi,
  onSqlChange,
  onDesignerChange,
  onExecute,
  onPrettify,
  onCancel,
  onExport,
  onApply,
  onRevert,
  openTab,
  gridState,
  patchGrid,
  updateGrid,
  onLayout,
  onLayoutCommit
}: TabContentProps): JSX.Element {
  const prefs = useAppStore((s) => s.prefs)
  const engine = engineOf(conn.config)
  const d = dialectFor(engine)

  if (tab.kind === 'export' || tab.kind === 'import') {
    return <ExportImportTab kind={tab.kind} config={conn.config} prefs={prefs} />
  }

  if (tab.kind === 'designer' && tab.designer) {
    return (
      <TableDesigner
        sessionId={conn.sessionId}
        state={tab.designer}
        schemas={conn.schemas}
        connected={conn.status === 'connected'}
        engine={engine}
        onChange={onDesignerChange}
        onApply={(sql) =>
          // Never runs by itself — the statement lands in a new tab for review.
          openTab({
            title: `${tab.designer?.mode === 'create' ? 'Create' : 'Alter'} ${tab.designer?.tableName}`,
            sql
          })
        }
      />
    )
  }

  return (
    <>
      <div className="pane fill">
        <div className="pane-head">
          <button
            className="toolbar-btn"
            title="Execute the selected portion of the script, or everything if nothing is selected (Ctrl+Shift+Enter)"
            disabled={isRunning}
            onClick={() => onExecute('all')}
          >
            <BoltIcon />
          </button>
          <button
            className="toolbar-btn"
            title="Execute the statement under the keyboard cursor (Ctrl+Enter)"
            disabled={isRunning}
            onClick={() => onExecute('current')}
          >
            <BoltCursorIcon />
          </button>
          <button
            className="toolbar-btn"
            title="Execute EXPLAIN for the statement under the keyboard cursor"
            disabled={isRunning}
            onClick={() => onExecute('explain')}
          >
            <BoltExplainIcon />
          </button>
          <button
            className="toolbar-btn"
            title="Stop the query being executed"
            disabled={!isRunning}
            onClick={onCancel}
          >
            <StopIcon />
          </button>
          <div className="toolbar-sep" />
          <button
            className="toolbar-btn"
            title="Beautify the statement under the cursor"
            onClick={onPrettify}
          >
            <BroomIcon />
          </button>
          <div className="spacer" />
          {isRunning && <span className="hint">Running… other tabs stay responsive</span>}
        </div>

        <QueryEditor
          tabId={tab.id}
          initialSql={tab.sql}
          onChange={onSqlChange}
          onExecuteCurrent={() => onExecute('current')}
          onExecuteAll={() => onExecute('all')}
          apiRef={editorApi}
          completionSchema={completionSchema}
          defaultSchema={conn.activeSchema}
          onNeedSchemaColumns={(schema) =>
            void useAppStore.getState().loadSchemaColumns(conn.sessionId, schema)
          }
          background={isValidHex(conn.config.color) ? tint(conn.config.color!, 0.14) : undefined}
          engine={engine}
        />
      </div>

      {showResults && tab.result && (
        <>
          <Splitter
            orientation="horizontal"
            size={conn.layout.resultsHeight}
            grow="after"
            min={80}
            max={900}
            onResize={(height) => onLayout({ resultsHeight: height })}
            onCommit={onLayoutCommit}
          />
          <div className="pane" style={{ height: conn.layout.resultsHeight, flex: 'none' }}>
            <div className="pane-head">
              <span className="pane-title">Result Grid</span>
              <button className="toolbar-btn" onClick={onExport} title="Export the result set">
                <ExportIcon /> Export
              </button>
              <div className="toolbar-sep" />
              <button
                className="toolbar-btn"
                disabled={!dirty || !canEdit}
                onClick={onApply}
                title={
                  canEdit
                    ? 'Review and run the SQL for your pending edits'
                    : 'These results have no primary key or id column, so they cannot be written back'
                }
              >
                Apply
              </button>
              <button className="toolbar-btn" disabled={!dirty} onClick={onRevert}>
                Revert
              </button>
              <div className="spacer" />
              <span className="hint">{tab.result.message}</span>
            </div>
            <ResultsGrid
              result={tab.result}
              state={gridState ?? emptyState}
              patch={patchGrid}
              update={updateGrid}
              editable={canEdit}
              dialect={d}
            />
          </div>
        </>
      )}

      {isRunning && (
        <div className="banner info">
          <span className="status-dot connecting" /> Executing…
        </div>
      )}
    </>
  )
}

const emptyState = {
  edits: {},
  deleted: {},
  added: [],
  selection: [],
  anchor: null,
  sort: null,
  columnWidths: {}
}
