/** IPC surface exposed to the renderer through the preload bridge. */

import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import type {
  ConnectionConfig,
  ConnectionGroup,
  IpcResult,
  Preferences,
  QueryTabState,
  SessionMeta,
  ToolName,
  ToolSettings
} from '@shared/types'
import { TOOL_SETTING_KEYS } from '@shared/types'
import { Session, testConnection } from './db/session'
import * as store from './store'
import {
  cancelAllTools,
  cancelTool,
  detectTool,
  runTool,
  toolVersion,
  type ToolRunRequest
} from './tools'
import { check, getUpdateState, installNow } from './updater'

/** Live sessions, keyed by connection *tab* id — several may share a connectionId. */
const sessions = new Map<string, Session>()

/** In-flight connection tests, keyed by the token the renderer made for each. */
const runningTests = new Map<string, { cancel?: () => void; cancelled: boolean }>()

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

async function envelope<T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (err: any) {
    return {
      ok: false,
      error: {
        message: err?.message ?? String(err),
        code: err?.code,
        errno: err?.errno,
        sqlState: err?.sqlState,
        // Carried through so the editor can mark where the server objected.
        statement: err?.statement,
        position: err?.position
      }
    }
  }
}

function handle<T>(channel: string, fn: (...args: any[]) => Promise<T> | T): void {
  ipcMain.handle(channel, (_event, ...args) => envelope(() => fn(...args)))
}

/** Merges global preferences with the connection's own overrides. */
async function effectivePrefs(config: ConnectionConfig): Promise<Preferences> {
  const global = await store.getPreferences()
  return { ...global, ...(config.prefs ?? {}) }
}

/** Closes every open session belonging to a connection that is about to vanish. */
async function closeSessionsFor(connectionId: string): Promise<void> {
  for (const [sessionId, session] of [...sessions]) {
    if (session['config']?.id === connectionId) {
      await session.close()
      sessions.delete(sessionId)
    }
  }
}

function requireSession(sessionId: string): Session {
  const session = sessions.get(sessionId)
  if (!session) throw new Error('This connection tab is no longer open')
  return session
}

export function registerIpc(): void {
  // --- connections -------------------------------------------------------

  handle('connections:list', () => store.listConnections())
  handle('connections:save', (config: ConnectionConfig) => store.saveConnection(config))
  handle('connections:delete', async (id: string) => {
    await closeSessionsFor(id)
    return store.deleteConnection(id)
  })
  handle('connections:test', async (config: ConnectionConfig, testId: string) => {
    // Registered before the first await so a cancel that races the start still lands.
    const entry: { cancel?: () => void; cancelled: boolean } = { cancelled: false }
    runningTests.set(testId, entry)
    try {
      const test = testConnection(config, await effectivePrefs(config))
      entry.cancel = test.cancel
      if (entry.cancelled) test.cancel()
      return await test.promise
    } finally {
      runningTests.delete(testId)
    }
  })
  handle('connections:testCancel', (testId: string) => {
    const entry = runningTests.get(testId)
    if (!entry) return false
    entry.cancelled = true
    entry.cancel?.()
    return true
  })
  handle('connections:arrange', (placements: { id: string; groupId: string | null }[]) =>
    store.arrangeConnections(placements)
  )
  handle('connections:export', (passphrase?: string) => store.exportConnections(passphrase))
  handle('connections:import', (payload: unknown, passphrase?: string) =>
    store.importConnections(payload, passphrase)
  )

  // --- connection groups -------------------------------------------------

  handle('groups:list', () => store.listGroups())
  handle('groups:save', (groups: ConnectionGroup[]) => store.saveGroups(groups))
  handle('groups:delete', async (id: string) => {
    // Deleting a group deletes the connections inside it, so their live
    // sessions have to go first — same as a single connection delete.
    const members = (await store.listConnections()).filter((c) => c.groupId === id)
    for (const member of members) await closeSessionsFor(member.id)
    return store.deleteGroup(id)
  })

  // --- preferences -------------------------------------------------------

  handle('prefs:get', () => store.getPreferences())
  handle('prefs:set', async (prefs: Preferences) => {
    const saved = await store.setPreferences(prefs)
    for (const session of sessions.values()) session.setPreferences(saved)
    return saved
  })

  // --- external tools (Data Export / Data Import) ------------------------

  handle('tools:get', async () => {
    const settings = await store.getToolSettings()
    // Probing costs a few stat calls, and finding the tools for the user beats
    // making them hunt for mysqldump.exe before their first export.
    const found: Partial<ToolSettings> = {}
    for (const [tool, key] of Object.entries(TOOL_SETTING_KEYS) as [ToolName, keyof ToolSettings][]) {
      if (settings[key]) continue
      const detected = detectTool(tool)
      if (detected) found[key] = detected
    }
    return Object.keys(found).length > 0 ? store.setToolSettings(found) : settings
  })
  handle('tools:set', (patch: Partial<ToolSettings>) => store.setToolSettings(patch))
  handle('tools:version', (toolPath: string) => toolVersion(toolPath))

  handle('tools:run', async (runId: string, config: ConnectionConfig, request: ToolRunRequest) => {
    await runTool(runId, config, request, await effectivePrefs(config), (event) =>
      broadcast('tools:event', event)
    )
  })
  handle('tools:cancel', (runId: string) => cancelTool(runId))

  // --- session lifecycle -------------------------------------------------

  handle('session:open', async (sessionId: string, config: ConnectionConfig) => {
    const existing = sessions.get(sessionId)
    if (existing) {
      existing.setConfig(config)
      return { status: existing.status, serverVersion: existing.serverVersion }
    }
    const session = new Session(sessionId, config, await effectivePrefs(config), {
      onStatus: (status, message, serverVersion) =>
        broadcast('session:status', { sessionId, status, message, serverVersion }),
      onLog: (level, message) => broadcast('session:log', { sessionId, level, message })
    })
    sessions.set(sessionId, session)
    return { status: session.status, serverVersion: session.serverVersion }
  })

  handle('session:connect', async (sessionId: string) => requireSession(sessionId).connect())

  handle('session:reconnect', async (sessionId: string, config: ConnectionConfig) =>
    requireSession(sessionId).reconnect(config, await effectivePrefs(config))
  )

  handle('session:close', async (sessionId: string) => {
    const session = sessions.get(sessionId)
    if (!session) return
    await session.close()
    sessions.delete(sessionId)
  })

  handle('session:status', (sessionId: string) => {
    const session = sessions.get(sessionId)
    return session
      ? { status: session.status, message: session.statusMessage, serverVersion: session.serverVersion }
      : { status: 'offline' as const }
  })

  // --- queries -----------------------------------------------------------

  handle('session:query', (sessionId: string, tabId: string, sql: string, limitRows?: number) =>
    requireSession(sessionId).query(tabId, sql, limitRows)
  )
  handle('session:cancel', (sessionId: string, tabId: string) =>
    requireSession(sessionId).cancel(tabId)
  )

  // --- metadata ----------------------------------------------------------

  handle('session:schemas', (sessionId: string) => requireSession(sessionId).listSchemas())
  handle('session:tableDefinition', (sessionId: string, schema: string, table: string) =>
    requireSession(sessionId).tableDefinition(schema, table)
  )
  handle('session:tableColumns', (sessionId: string, schema: string, table: string) =>
    requireSession(sessionId).tableColumns(schema, table)
  )
  handle('session:schemaColumns', (sessionId: string, schema: string) =>
    requireSession(sessionId).schemaColumns(schema)
  )
  handle(
    'session:createStatement',
    (sessionId: string, kind: 'table' | 'schema', schema: string, table?: string) =>
      requireSession(sessionId).createStatement(kind, schema, table)
  )
  handle('session:charsets', (sessionId: string) => requireSession(sessionId).charsets())

  // --- persisted session state ------------------------------------------

  handle('storage:meta:get', (connectionId: string) => store.getSessionMeta(connectionId))
  handle('storage:meta:set', (meta: SessionMeta) => store.setSessionMeta(meta))
  handle('storage:tabs:load', (connectionId: string) => store.loadTabs(connectionId))
  handle('storage:tab:save', async (connectionId: string, tab: QueryTabState) => {
    const prefs = await store.getPreferences()
    return store.saveTab(connectionId, tab, prefs.maxTabSizeToSave)
  })
  handle('storage:tab:delete', (connectionId: string, tabId: string) =>
    store.deleteTab(connectionId, tabId)
  )

  // --- shell helpers -----------------------------------------------------

  handle('clipboard:write', (text: string) => {
    clipboard.writeText(text)
  })
  handle('clipboard:read', () => clipboard.readText())

  handle(
    'dialog:openFile',
    async (title: string, filters?: Electron.FileFilter[], defaultPath?: string) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const result = await dialog.showOpenDialog(win, {
        title,
        properties: ['openFile'],
        filters,
        defaultPath
      })
      return result.canceled ? null : result.filePaths[0]
    }
  )

  handle('dialog:openDirectory', async (title: string, defaultPath?: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title,
      properties: ['openDirectory'],
      defaultPath
    })
    return result.canceled ? null : result.filePaths[0]
  })

  handle('dialog:saveFile', async (title: string, defaultPath: string, filters?: Electron.FileFilter[]) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showSaveDialog(win, { title, defaultPath, filters })
    return result.canceled ? null : result.filePath
  })

  handle('shell:writeFile', async (filePath: string, contents: string) => {
    const fsp = await import('node:fs/promises')
    await fsp.writeFile(filePath, contents, 'utf8')
  })

  handle('shell:readFile', async (filePath: string) => {
    const fsp = await import('node:fs/promises')
    return fsp.readFile(filePath, 'utf8')
  })

  handle('shell:showItem', (filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  handle('shell:exists', async (filePath: string) => {
    const fsp = await import('node:fs/promises')
    return fsp
      .stat(filePath)
      .then(() => true)
      .catch(() => false)
  })

  handle('updates:get', () => getUpdateState())
  handle('updates:check', () => check())
  handle('updates:install', () => installNow())

  // --- about -------------------------------------------------------------

  handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }))
}

/**
 * Closes every worker on shutdown so no MySQL sockets are left dangling, and
 * stops any dump still running — its temporary password file is only deleted by
 * the code that started it.
 */
export async function shutdownSessions(): Promise<void> {
  await cancelAllTools()
  await Promise.all([...sessions.values()].map((s) => s.close()))
  sessions.clear()
}
