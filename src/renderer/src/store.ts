import { create } from 'zustand'
import {
  DEFAULT_LAYOUT,
  DEFAULT_PREFERENCES,
  type ConnectionConfig,
  type ConnectionGroup,
  type HistoryEntry,
  type Preferences,
  type QueryTabState,
  type SchemaInfo,
  type SessionLayout,
  type SessionStatus,
  type TabKind
} from '@shared/types'
import { guessTableName, splitStatements } from '@shared/sql'
import { newId } from './lib/ids'
import { emptyGridState, type GridState } from './lib/grid'

/** One open connection tab. Several may point at the same saved connection. */
export interface ConnTab {
  sessionId: string
  connectionId: string
  name: string
  config: ConnectionConfig
  status: SessionStatus
  statusMessage?: string
  serverVersion?: string
  /** Only the first tab for a connection owns its saved tabs and schema cache. */
  isPrimary: boolean

  schemas: SchemaInfo[]
  schemasFetchedAt: number
  schemasLoading: boolean
  /** `schema.table` -> column names, for code completion and copy templates. */
  columnsCache: Record<string, string[]>
  expanded: Record<string, boolean>
  activeSchema: string | null
  selectedNode: string | null
  filter: string

  tabs: QueryTabState[]
  activeTabId: string | null
  running: Record<string, boolean>

  history: HistoryEntry[]
  historySeq: number

  layout: SessionLayout
}

interface AppState {
  connections: ConnectionConfig[]
  /** Home-screen groups, in display order. */
  groups: ConnectionGroup[]
  prefs: Preferences
  connTabs: ConnTab[]
  /** `null` means the Home tab is showing. */
  activeSessionId: string | null
  ready: boolean
  /** `sessionId:tabId` entries awaiting an autosave write. */
  dirtyTabs: Record<string, true>

  init(): Promise<void>
  setConnections(connections: ConnectionConfig[]): void
  setGroups(groups: ConnectionGroup[]): void
  setPrefs(prefs: Preferences): Promise<void>

  openConnection(config: ConnectionConfig, connect: boolean): Promise<string>
  closeConnTab(sessionId: string): Promise<void>
  setActiveSession(sessionId: string | null): void
  reconnect(sessionId: string): Promise<boolean>
  applyStatus(sessionId: string, status: SessionStatus, message?: string, serverVersion?: string): void

  refreshSchemas(sessionId: string, force?: boolean): Promise<void>
  loadSchemaColumns(sessionId: string, schema: string): Promise<void>
  toggleExpanded(sessionId: string, key: string): void
  setSchemaFilter(sessionId: string, filter: string): void
  setSelectedNode(sessionId: string, key: string | null): void
  setActiveSchema(sessionId: string, schema: string | null): void

  newTab(sessionId: string, options?: NewTabOptions): string
  closeTab(sessionId: string, tabId: string): void
  closeTabs(sessionId: string, tabIds: string[]): void
  setActiveTab(sessionId: string, tabId: string): void
  updateTab(sessionId: string, tabId: string, patch: Partial<QueryTabState>): void

  runQuery(sessionId: string, tabId: string, sql: string, options?: RunOptions): Promise<void>
  cancelQuery(sessionId: string, tabId: string): Promise<void>

  pushHistory(sessionId: string, entry: Omit<HistoryEntry, 'id' | 'seq'>): string
  updateHistory(sessionId: string, id: string, patch: Partial<HistoryEntry>): void

  setLayout(sessionId: string, patch: Partial<SessionLayout>): void
  markDirty(sessionId: string, tabId: string): void
  flushAutosave(): Promise<void>
  persistMeta(sessionId: string): Promise<void>
}

export interface NewTabOptions {
  title?: string
  sql?: string
  kind?: TabKind
  designer?: QueryTabState['designer']
  /** Run the SQL as soon as the tab opens. Only ever set for read-only SQL. */
  run?: boolean
  activate?: boolean
}

export interface RunOptions {
  /** Wraps each statement in EXPLAIN. */
  explain?: boolean
  /** Label shown in the history view instead of the raw SQL. */
  label?: string
}

function makeTab(options: NewTabOptions, index: number): QueryTabState {
  const sql = options.sql ?? ''
  const guessed = options.title ?? (sql ? guessTableName(sql) : null)
  return {
    id: newId('tab'),
    kind: options.kind ?? 'query',
    title: guessed || `Query ${index + 1}`,
    autoTitle: !options.title,
    sql,
    result: null,
    resultStatement: '',
    designer: options.designer ?? null,
    cursorLine: 1,
    updatedAt: Date.now()
  }
}

/** `sessionId schema` keys whose column fetch is already in flight. */
const columnsInflight = new Set<string>()

export const useAppStore = create<AppState>((set, get) => {
  /** Applies `fn` to one connection tab and returns the new state. */
  const patchConn = (sessionId: string, fn: (tab: ConnTab) => ConnTab): void => {
    set((state) => ({
      connTabs: state.connTabs.map((t) => (t.sessionId === sessionId ? fn(t) : t))
    }))
  }

  const conn = (sessionId: string): ConnTab | undefined =>
    get().connTabs.find((t) => t.sessionId === sessionId)

  return {
    connections: [],
    groups: [],
    prefs: DEFAULT_PREFERENCES,
    connTabs: [],
    activeSessionId: null,
    ready: false,
    dirtyTabs: {},

    async init() {
      // The IPC bridge only exists in the Electron shell; bail out cleanly when
      // the page is loaded in a plain browser (App renders a notice instead).
      if (typeof window === 'undefined' || !window.api) return

      const [connections, groups, prefs] = await Promise.all([
        window.api.connections.list(),
        window.api.groups.list(),
        window.api.prefs.get()
      ])
      set({ connections, groups, prefs, ready: true })

      window.api.session.onStatus((event) => {
        get().applyStatus(event.sessionId, event.status, event.message, event.serverVersion)
      })
    },

    setConnections(connections) {
      set({ connections })
      // Keep open tabs pointing at the latest config after an edit.
      set((state) => ({
        connTabs: state.connTabs.map((tab) => {
          const config = connections.find((c) => c.id === tab.connectionId)
          return config ? { ...tab, config, name: config.name } : tab
        })
      }))
    },

    setGroups(groups) {
      set({ groups })
    },

    async setPrefs(prefs) {
      const saved = await window.api.prefs.set(prefs)
      set({ prefs: saved })
    },

    async openConnection(config, shouldConnect) {
      const sessionId = newId('sess')
      const isPrimary = !get().connTabs.some((t) => t.connectionId === config.id)

      const tab: ConnTab = {
        sessionId,
        connectionId: config.id,
        name: config.name,
        config,
        status: 'offline',
        isPrimary,
        schemas: [],
        schemasFetchedAt: 0,
        schemasLoading: false,
        columnsCache: {},
        expanded: {},
        activeSchema: config.defaultSchema || null,
        selectedNode: null,
        filter: '',
        tabs: [],
        activeTabId: null,
        running: {},
        history: [],
        historySeq: 0,
        layout: { ...DEFAULT_LAYOUT }
      }

      set((state) => ({ connTabs: [...state.connTabs, tab], activeSessionId: sessionId }))

      // Restore cached schemas and saved tabs first so the tab is usable offline.
      if (isPrimary) {
        try {
          const [meta, tabs] = await Promise.all([
            window.api.storage.getMeta(config.id),
            window.api.storage.loadTabs(config.id)
          ])
          patchConn(sessionId, (t) => ({
            ...t,
            schemas: meta.schemas,
            schemasFetchedAt: meta.schemasFetchedAt,
            expanded: Object.fromEntries(meta.expandedSchemas.map((k) => [k, true])),
            // A stored null means "nothing chosen", which falls back to the
            // connection's default schema rather than to no schema at all.
            activeSchema: meta.activeSchema ?? t.activeSchema,
            layout: meta.layout,
            tabs,
            activeTabId:
              meta.activeTabId && tabs.some((x) => x.id === meta.activeTabId)
                ? meta.activeTabId
                : (tabs[0]?.id ?? null)
          }))
        } catch (err) {
          console.error('Failed to restore session state', err)
        }
      }

      // Always leave the user with at least one tab to type in.
      if (conn(sessionId)?.tabs.length === 0) {
        get().newTab(sessionId)
      }

      await window.api.session.open(sessionId, config)

      if (shouldConnect) {
        try {
          await window.api.session.connect(sessionId)
          await get().refreshSchemas(sessionId, true)
        } catch (err) {
          patchConn(sessionId, (t) => ({
            ...t,
            status: 'error',
            statusMessage: (err as Error).message
          }))
          get().pushHistory(sessionId, {
            status: 'error',
            startedAt: Date.now(),
            action: 'Connect',
            message: (err as Error).message,
            durationMs: null,
            fetchMs: null
          })
        }
      }

      return sessionId
    },

    async closeConnTab(sessionId) {
      const tab = conn(sessionId)
      if (!tab) return
      await get().persistMeta(sessionId)
      await window.api.session.close(sessionId).catch(() => undefined)

      set((state) => {
        const remaining = state.connTabs.filter((t) => t.sessionId !== sessionId)
        // If another tab for the same connection is still open, promote it.
        const promoted = tab.isPrimary
          ? remaining.map((t) =>
              t.connectionId === tab.connectionId && !t.isPrimary ? { ...t, isPrimary: true } : t
            )
          : remaining
        const wasActive = state.activeSessionId === sessionId
        return {
          connTabs: promoted,
          activeSessionId: wasActive ? (promoted[promoted.length - 1]?.sessionId ?? null) : state.activeSessionId
        }
      })
    },

    setActiveSession(sessionId) {
      set({ activeSessionId: sessionId })
    },

    async reconnect(sessionId) {
      const tab = conn(sessionId)
      if (!tab) return false
      const started = Date.now()
      const historyId = get().pushHistory(sessionId, {
        status: 'running',
        startedAt: started,
        action: 'Reconnect',
        message: 'Reconnecting…',
        durationMs: null,
        fetchMs: null
      })
      try {
        await window.api.session.reconnect(sessionId, tab.config)
        get().updateHistory(sessionId, historyId, {
          status: 'ok',
          message: 'Connected',
          durationMs: Date.now() - started
        })
        await get().refreshSchemas(sessionId, true)
        return true
      } catch (err) {
        get().updateHistory(sessionId, historyId, {
          status: 'error',
          message: (err as Error).message,
          durationMs: Date.now() - started
        })
        return false
      }
    },

    applyStatus(sessionId, status, message, serverVersion) {
      patchConn(sessionId, (t) => ({
        ...t,
        status,
        statusMessage: message ?? (status === 'connected' ? undefined : t.statusMessage),
        serverVersion: serverVersion ?? t.serverVersion
      }))
    },

    async refreshSchemas(sessionId, force = false) {
      const tab = conn(sessionId)
      if (!tab) return
      if (tab.schemasLoading) return
      if (!force && tab.schemas.length > 0) return

      patchConn(sessionId, (t) => ({ ...t, schemasLoading: true }))
      try {
        const schemas = await window.api.session.schemas(sessionId)
        patchConn(sessionId, (t) => ({
          ...t,
          schemas,
          schemasFetchedAt: Date.now(),
          schemasLoading: false
        }))
        void get().persistMeta(sessionId)
      } catch (err) {
        patchConn(sessionId, (t) => ({ ...t, schemasLoading: false }))
        get().pushHistory(sessionId, {
          status: 'error',
          startedAt: Date.now(),
          action: 'Load schemas',
          message: (err as Error).message,
          durationMs: null,
          fetchMs: null
        })
      }
    },

    async loadSchemaColumns(sessionId, schema) {
      const tab = conn(sessionId)
      if (!tab || tab.status !== 'connected') return
      // Cached already if any table from this schema is present.
      if (Object.keys(tab.columnsCache).some((k) => k.startsWith(`${schema}.`))) return
      // Completion asks on every keystroke, so collapse concurrent requests.
      const inflightKey = `${sessionId} ${schema}`
      if (columnsInflight.has(inflightKey)) return
      columnsInflight.add(inflightKey)
      try {
        const columns = await window.api.session.schemaColumns(sessionId, schema)
        patchConn(sessionId, (t) => {
          const next = { ...t.columnsCache }
          for (const [table, names] of Object.entries(columns)) next[`${schema}.${table}`] = names
          return { ...t, columnsCache: next }
        })
      } catch {
        /* completion is best-effort */
      } finally {
        columnsInflight.delete(inflightKey)
      }
    },

    toggleExpanded(sessionId, key) {
      patchConn(sessionId, (t) => ({
        ...t,
        expanded: { ...t.expanded, [key]: !t.expanded[key] }
      }))
      void get().persistMeta(sessionId)
    },

    setSchemaFilter(sessionId, filter) {
      patchConn(sessionId, (t) => ({ ...t, filter }))
    },

    setSelectedNode(sessionId, key) {
      patchConn(sessionId, (t) => ({ ...t, selectedNode: key }))
    },

    setActiveSchema(sessionId, schema) {
      patchConn(sessionId, (t) => ({ ...t, activeSchema: schema }))
      void get().persistMeta(sessionId)
    },

    newTab(sessionId, options = {}) {
      const tab = conn(sessionId)
      if (!tab) return ''
      const created = makeTab(options, tab.tabs.length)

      patchConn(sessionId, (t) => ({
        ...t,
        tabs: [...t.tabs, created],
        activeTabId: options.activate === false ? t.activeTabId : created.id
      }))
      get().markDirty(sessionId, created.id)
      void get().persistMeta(sessionId)

      if (options.run && created.sql.trim()) {
        void get().runQuery(sessionId, created.id, created.sql)
      }
      return created.id
    },

    closeTab(sessionId, tabId) {
      get().closeTabs(sessionId, [tabId])
    },

    closeTabs(sessionId, tabIds) {
      const tab = conn(sessionId)
      if (!tab) return
      const remove = new Set(tabIds)

      patchConn(sessionId, (t) => {
        const tabs = t.tabs.filter((x) => !remove.has(x.id))
        let activeTabId = t.activeTabId
        if (activeTabId && remove.has(activeTabId)) {
          const index = t.tabs.findIndex((x) => x.id === activeTabId)
          const next = tabs[Math.min(index, tabs.length - 1)]
          activeTabId = next?.id ?? null
        }
        const running = { ...t.running }
        for (const id of remove) delete running[id]
        return { ...t, tabs, activeTabId, running }
      })

      if (tab.isPrimary) {
        for (const id of tabIds) void window.api.storage.deleteTab(tab.connectionId, id)
      }
      set((state) => {
        const dirty = { ...state.dirtyTabs }
        for (const id of tabIds) delete dirty[`${sessionId}:${id}`]
        return { dirtyTabs: dirty }
      })

      // Never leave a connection with zero tabs.
      if (conn(sessionId)?.tabs.length === 0) get().newTab(sessionId)
      void get().persistMeta(sessionId)
    },

    setActiveTab(sessionId, tabId) {
      patchConn(sessionId, (t) => ({ ...t, activeTabId: tabId }))
      void get().persistMeta(sessionId)
    },

    updateTab(sessionId, tabId, patch) {
      patchConn(sessionId, (t) => ({
        ...t,
        tabs: t.tabs.map((x) => (x.id === tabId ? { ...x, ...patch, updatedAt: Date.now() } : x))
      }))
      get().markDirty(sessionId, tabId)
    },

    async runQuery(sessionId, tabId, sql, options = {}) {
      const tab = conn(sessionId)
      if (!tab) return
      const trimmed = sql.trim()
      if (!trimmed) return

      if (tab.running[tabId]) return

      if (tab.status !== 'connected') {
        // The session can be left disconnected by a dropped socket the worker
        // could not repair on its own. Reopen it here rather than making the
        // user hunt for the Reconnect button before every query.
        const recovered = await get().reconnect(sessionId)
        if (!recovered) {
          get().pushHistory(sessionId, {
            status: 'error',
            startedAt: Date.now(),
            action: trimmed,
            message: 'Not connected. Use Reconnect to open the connection.',
            durationMs: null,
            fetchMs: null
          })
          return
        }
      }

      const statements = splitStatements(trimmed, tab.config.engine)
      const toRun = options.explain
        ? statements.map((s) => `EXPLAIN ${s.text}`).join(';\n') + ';'
        : trimmed

      patchConn(sessionId, (t) => ({ ...t, running: { ...t.running, [tabId]: true } }))

      const started = Date.now()
      const label = options.label ?? (options.explain ? `EXPLAIN ${statements[0]?.text ?? ''}` : trimmed)
      const historyId = get().pushHistory(sessionId, {
        status: 'running',
        startedAt: started,
        action: label,
        message: 'Running…',
        durationMs: null,
        fetchMs: null
      })

      try {
        const outcome = await window.api.session.query(sessionId, tabId, toRun)
        // Show the last statement that produced a grid; otherwise the last one.
        const withRows = [...outcome.results].reverse().find((r) => r.columns.length > 0)
        const chosen = withRows ?? outcome.results[outcome.results.length - 1]
        const chosenIndex = outcome.results.indexOf(chosen)

        const totalDuration = outcome.results.reduce((sum, r) => sum + r.durationMs, 0)
        const totalFetch = outcome.results.reduce((sum, r) => sum + r.fetchMs, 0)

        get().updateHistory(sessionId, historyId, {
          status: 'ok',
          message:
            outcome.results.length > 1
              ? `${outcome.results.length} statements, ${chosen?.message ?? ''}`
              : (chosen?.message ?? 'OK'),
          durationMs: totalDuration,
          fetchMs: totalFetch
        })

        const current = conn(sessionId)?.tabs.find((t) => t.id === tabId)
        const nextTitle =
          current?.autoTitle && !options.explain
            ? (guessTableName(statements[0]?.text ?? '') ?? current.title)
            : current?.title

        get().updateTab(sessionId, tabId, {
          result: chosen ?? null,
          resultStatement: outcome.statements[chosenIndex] ?? trimmed,
          title: nextTitle
        })
      } catch (err) {
        get().updateHistory(sessionId, historyId, {
          status: 'error',
          message: (err as Error).message,
          durationMs: Date.now() - started,
          fetchMs: 0
        })
        get().updateTab(sessionId, tabId, {
          result: null,
          resultStatement: (err as Error).message
        })
      } finally {
        patchConn(sessionId, (t) => {
          const running = { ...t.running }
          delete running[tabId]
          return { ...t, running }
        })
      }
    },

    async cancelQuery(sessionId, tabId) {
      try {
        await window.api.session.cancel(sessionId, tabId)
      } catch (err) {
        console.error('Cancel failed', err)
      }
    },

    pushHistory(sessionId, entry) {
      const id = newId('h')
      patchConn(sessionId, (t) => ({
        ...t,
        historySeq: t.historySeq + 1,
        // Cap the log so a long session cannot grow without bound.
        history: [...t.history, { ...entry, id, seq: t.historySeq + 1 }].slice(-500)
      }))
      return id
    },

    updateHistory(sessionId, id, patch) {
      patchConn(sessionId, (t) => ({
        ...t,
        history: t.history.map((h) => (h.id === id ? { ...h, ...patch } : h))
      }))
    },

    setLayout(sessionId, patch) {
      patchConn(sessionId, (t) => ({ ...t, layout: { ...t.layout, ...patch } }))
    },

    markDirty(sessionId, tabId) {
      set((state) => ({ dirtyTabs: { ...state.dirtyTabs, [`${sessionId}:${tabId}`]: true } }))
    },

    async flushAutosave() {
      const { dirtyTabs, connTabs } = get()
      const keys = Object.keys(dirtyTabs)
      if (keys.length === 0) return
      set({ dirtyTabs: {} })

      await Promise.all(
        keys.map(async (key) => {
          const [sessionId, tabId] = key.split(':')
          const connection = connTabs.find((t) => t.sessionId === sessionId)
          if (!connection || !connection.isPrimary) return
          const tab = connection.tabs.find((t) => t.id === tabId)
          if (!tab) return
          try {
            await window.api.storage.saveTab(connection.connectionId, tab)
          } catch (err) {
            console.error('Autosave failed', err)
          }
        })
      )
    },

    async persistMeta(sessionId) {
      const tab = conn(sessionId)
      if (!tab || !tab.isPrimary) return
      try {
        await window.api.storage.setMeta({
          connectionId: tab.connectionId,
          tabIds: tab.tabs.map((t) => t.id),
          activeTabId: tab.activeTabId,
          expandedSchemas: Object.keys(tab.expanded).filter((k) => tab.expanded[k]),
          activeSchema: tab.activeSchema,
          schemas: tab.schemas,
          schemasFetchedAt: tab.schemasFetchedAt,
          layout: tab.layout
        })
      } catch (err) {
        console.error('Failed to persist session meta', err)
      }
    }
  }
})

// ---------------------------------------------------------------------------
// Grid state lives in its own store so a 1000-row grid does not re-render on
// every unrelated app change.
// ---------------------------------------------------------------------------

interface GridStore {
  states: Record<string, GridState>
  get(key: string): GridState
  patch(key: string, patch: Partial<GridState>): void
  update(key: string, fn: (state: GridState) => GridState): void
  reset(key: string): void
  drop(key: string): void
}

export const gridKey = (sessionId: string, tabId: string): string => `${sessionId}:${tabId}`

export const useGridStore = create<GridStore>((set, get) => ({
  states: {},

  get(key) {
    return get().states[key] ?? emptyGridState()
  },

  patch(key, patch) {
    set((state) => ({
      states: { ...state.states, [key]: { ...(state.states[key] ?? emptyGridState()), ...patch } }
    }))
  },

  update(key, fn) {
    set((state) => ({
      states: { ...state.states, [key]: fn(state.states[key] ?? emptyGridState()) }
    }))
  },

  reset(key) {
    set((state) => {
      const previous = state.states[key] ?? emptyGridState()
      // Keep view-only preferences (sort, widths) across a revert.
      return {
        states: {
          ...state.states,
          [key]: { ...emptyGridState(), sort: previous.sort, columnWidths: previous.columnWidths }
        }
      }
    })
  },

  drop(key) {
    set((state) => {
      const next = { ...state.states }
      delete next[key]
      return { states: next }
    })
  }
}))
