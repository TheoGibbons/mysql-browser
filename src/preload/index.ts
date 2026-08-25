import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfo,
  ConnectionConfig,
  ConnectionGroup,
  ConnectionSecretsEnvelope,
  IpcResult,
  Preferences,
  QueryOutcome,
  QueryTabState,
  SchemaInfo,
  SessionMeta,
  SessionStatus,
  SessionStatusEvent,
  TableDefinition,
  ToolRunEvent,
  ToolSettings,
  UpdateState
} from '@shared/types'

/** Unwraps the IPC envelope, rethrowing failures as ordinary errors. */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (result.ok) return result.data
  const error = new Error(result.error.message) as Error & {
    code?: string
    errno?: number
    sqlState?: string
  }
  error.code = result.error.code
  error.errno = result.error.errno
  error.sqlState = result.error.sqlState
  throw error
}

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  /** Lets the renderer pick a path separator without guessing. */
  platform: process.platform as NodeJS.Platform,

  connections: {
    list: () => call<ConnectionConfig[]>('connections:list'),
    save: (config: ConnectionConfig) => call<ConnectionConfig[]>('connections:save', config),
    remove: (id: string) => call<ConnectionConfig[]>('connections:delete', id),
    /** `testId` is a caller-made token that `testCancel` can stop the test with. */
    test: (config: ConnectionConfig, testId: string) =>
      call<{ serverVersion: string; latencyMs: number }>('connections:test', config, testId),
    testCancel: (testId: string) => call<boolean>('connections:testCancel', testId),
    /** The complete display order, each entry with the group it now sits in. */
    arrange: (placements: { id: string; groupId: string | null }[]) =>
      call<ConnectionConfig[]>('connections:arrange', placements),
    /** With a passphrase the export carries every password in `secrets`. */
    exportAll: (passphrase?: string) =>
      call<{
        connections: ConnectionConfig[]
        groups: ConnectionGroup[]
        secrets?: ConnectionSecretsEnvelope
        withSecrets: number
      }>('connections:export', passphrase),
    /** Resolves to `{ badPassphrase: true }` when `secrets` will not open — retryable. */
    importAll: (payload: unknown, passphrase?: string) =>
      call<
        | {
            connections: ConnectionConfig[]
            groups: ConnectionGroup[]
            added: number
            updated: number
            skipped: number
            restored: number
          }
        | { badPassphrase: true }
      >('connections:import', payload, passphrase)
  },

  groups: {
    list: () => call<ConnectionGroup[]>('groups:list'),
    save: (groups: ConnectionGroup[]) => call<ConnectionGroup[]>('groups:save', groups),
    /** Also deletes every connection inside the group. */
    remove: (id: string) =>
      call<{ connections: ConnectionConfig[]; groups: ConnectionGroup[] }>('groups:delete', id)
  },

  prefs: {
    get: () => call<Preferences>('prefs:get'),
    set: (prefs: Preferences) => call<Preferences>('prefs:set', prefs)
  },

  session: {
    open: (sessionId: string, config: ConnectionConfig) =>
      call<{ status: SessionStatus; serverVersion?: string }>('session:open', sessionId, config),
    connect: (sessionId: string) => call<{ serverVersion: string }>('session:connect', sessionId),
    reconnect: (sessionId: string, config: ConnectionConfig) =>
      call<{ serverVersion: string }>('session:reconnect', sessionId, config),
    close: (sessionId: string) => call<void>('session:close', sessionId),
    status: (sessionId: string) =>
      call<{ status: SessionStatus; message?: string; serverVersion?: string }>(
        'session:status',
        sessionId
      ),

    query: (sessionId: string, tabId: string, sql: string, limitRows?: number) =>
      call<QueryOutcome>('session:query', sessionId, tabId, sql, limitRows),
    cancel: (sessionId: string, tabId: string) =>
      call<{ killed: boolean }>('session:cancel', sessionId, tabId),

    schemas: (sessionId: string) => call<SchemaInfo[]>('session:schemas', sessionId),
    tableDefinition: (sessionId: string, schema: string, table: string) =>
      call<TableDefinition>('session:tableDefinition', sessionId, schema, table),
    tableColumns: (sessionId: string, schema: string, table: string) =>
      call<string[]>('session:tableColumns', sessionId, schema, table),
    schemaColumns: (sessionId: string, schema: string) =>
      call<Record<string, string[]>>('session:schemaColumns', sessionId, schema),
    createStatement: (sessionId: string, kind: 'table' | 'schema', schema: string, table?: string) =>
      call<string>('session:createStatement', sessionId, kind, schema, table),
    charsets: (sessionId: string) =>
      call<{ charset: string; collations: string[] }[]>('session:charsets', sessionId),

    onStatus: (handler: (event: SessionStatusEvent) => void) =>
      subscribe<SessionStatusEvent>('session:status', handler),
    onLog: (handler: (event: { sessionId: string; level: string; message: string }) => void) =>
      subscribe('session:log', handler)
  },

  storage: {
    getMeta: (connectionId: string) => call<SessionMeta>('storage:meta:get', connectionId),
    setMeta: (meta: SessionMeta) => call<void>('storage:meta:set', meta),
    loadTabs: (connectionId: string) => call<QueryTabState[]>('storage:tabs:load', connectionId),
    saveTab: (connectionId: string, tab: QueryTabState) =>
      call<void>('storage:tab:save', connectionId, tab),
    deleteTab: (connectionId: string, tabId: string) =>
      call<void>('storage:tab:delete', connectionId, tabId)
  },

  clipboard: {
    write: (text: string) => call<void>('clipboard:write', text),
    read: () => call<string>('clipboard:read')
  },

  tools: {
    /** Paths and directories, with any tool found on this machine filled in. */
    get: () => call<ToolSettings>('tools:get'),
    /** Merges a patch — a tab remembers one field without knowing the rest. */
    set: (patch: Partial<ToolSettings>) => call<ToolSettings>('tools:set', patch),
    /** Runs the selected executable with `--version` and returns its version line. */
    version: (toolPath: string) => call<string>('tools:version', toolPath),
    /**
     * Runs a dump/restore command. Resolves when the tool has exited; watch
     * `onEvent` for its output, progress and exit status.
     */
    run: (
      runId: string,
      config: ConnectionConfig,
      request: { command: string; outputPath?: string }
    ) => call<void>('tools:run', runId, config, request),
    cancel: (runId: string) => call<boolean>('tools:cancel', runId),
    onEvent: (handler: (event: ToolRunEvent) => void) =>
      subscribe<ToolRunEvent>('tools:event', handler)
  },

  dialog: {
    openFile: (
      title: string,
      filters?: { name: string; extensions: string[] }[],
      defaultPath?: string
    ) => call<string | null>('dialog:openFile', title, filters, defaultPath),
    openDirectory: (title: string, defaultPath?: string) =>
      call<string | null>('dialog:openDirectory', title, defaultPath),
    saveFile: (title: string, defaultPath: string, filters?: { name: string; extensions: string[] }[]) =>
      call<string | null>('dialog:saveFile', title, defaultPath, filters)
  },

  files: {
    write: (filePath: string, contents: string) => call<void>('shell:writeFile', filePath, contents),
    read: (filePath: string) => call<string>('shell:readFile', filePath),
    reveal: (filePath: string) => call<void>('shell:showItem', filePath),
    /** True for a directory as well — anything that would be written over. */
    exists: (filePath: string) => call<boolean>('shell:exists', filePath)
  },

  updates: {
    get: () => call<UpdateState>('updates:get'),
    check: () => call<UpdateState>('updates:check'),
    /** Quits and relaunches into the staged version. False if none is staged. */
    install: () => call<boolean>('updates:install'),
    onState: (handler: (state: UpdateState) => void) =>
      subscribe<UpdateState>('updates:state', handler)
  },

  app: {
    /** The running build's version, plus the runtime it sits on. */
    info: () => call<AppInfo>('app:info')
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
