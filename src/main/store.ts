/**
 * File-backed storage under the app's userData directory.
 *
 *   connections.json                    saved connections (secrets encrypted)
 *   preferences.json                    global preferences
 *   sessions/<connectionId>/meta.json   schema cache, open tabs, layout
 *   sessions/<connectionId>/tabs/*.json one file per tab (spec: one file per tab)
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import {
  DEFAULT_LAYOUT,
  DEFAULT_PREFERENCES,
  type ConnectionConfig,
  type Preferences,
  type QueryTabState,
  type SessionMeta
} from '@shared/types'

/** Marks a value as ciphertext so plaintext fallbacks stay readable. */
const ENC_PREFIX = 'enc:v1:'
const SECRET_FIELDS = ['password', 'sshPassword', 'sshPassphrase'] as const

let rootDir = ''

export function initStore(): void {
  rootDir = app.getPath('userData')
  fs.mkdirSync(path.join(rootDir, 'sessions'), { recursive: true })
}

function file(...parts: string[]): string {
  return path.join(rootDir, ...parts)
}

/** Keeps a connection id usable as a directory name. */
function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_')
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Failed to read ${filePath}:`, err)
    }
    return fallback
  }
}

/** Writes via a temp file + rename so a crash can never leave a half-written tab. */
async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(value), 'utf8')
  await fsp.rename(tmp, filePath)
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

function encrypt(value: string): string {
  if (!value) return ''
  if (!safeStorage.isEncryptionAvailable()) return value
  return ENC_PREFIX + safeStorage.encryptString(value).toString('base64')
}

function decrypt(value: string | undefined): string | undefined {
  if (!value) return value
  if (!value.startsWith(ENC_PREFIX)) return value
  if (!safeStorage.isEncryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}

function protect(config: ConnectionConfig): ConnectionConfig {
  const out = { ...config }
  for (const key of SECRET_FIELDS) {
    const value = out[key]
    if (value) out[key] = encrypt(value)
  }
  return out
}

function unprotect(config: ConnectionConfig): ConnectionConfig {
  const out = { ...config }
  for (const key of SECRET_FIELDS) {
    const value = out[key]
    if (value) out[key] = decrypt(value)
  }
  return out
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export async function listConnections(): Promise<ConnectionConfig[]> {
  const stored = await readJson<ConnectionConfig[]>(file('connections.json'), [])
  return stored.map(unprotect)
}

export async function saveConnection(config: ConnectionConfig): Promise<ConnectionConfig[]> {
  const stored = await readJson<ConnectionConfig[]>(file('connections.json'), [])
  const index = stored.findIndex((c) => c.id === config.id)
  const next = protect(config)
  if (index >= 0) stored[index] = next
  else stored.push(next)
  await writeJson(file('connections.json'), stored)
  return stored.map(unprotect)
}

export async function deleteConnection(id: string): Promise<ConnectionConfig[]> {
  const stored = await readJson<ConnectionConfig[]>(file('connections.json'), [])
  const next = stored.filter((c) => c.id !== id)
  await writeJson(file('connections.json'), next)
  await fsp.rm(file('sessions', safeId(id)), { recursive: true, force: true }).catch(() => undefined)
  return next.map(unprotect)
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export async function getPreferences(): Promise<Preferences> {
  const stored = await readJson<Partial<Preferences>>(file('preferences.json'), {})
  return { ...DEFAULT_PREFERENCES, ...stored }
}

export async function setPreferences(prefs: Preferences): Promise<Preferences> {
  const merged = { ...DEFAULT_PREFERENCES, ...prefs }
  await writeJson(file('preferences.json'), merged)
  return merged
}

// ---------------------------------------------------------------------------
// Session state (schema cache, tabs, layout)
// ---------------------------------------------------------------------------

function sessionDir(connectionId: string): string {
  return file('sessions', safeId(connectionId))
}

export async function getSessionMeta(connectionId: string): Promise<SessionMeta> {
  return readJson<SessionMeta>(path.join(sessionDir(connectionId), 'meta.json'), {
    connectionId,
    tabIds: [],
    activeTabId: null,
    expandedSchemas: [],
    activeSchema: null,
    schemas: [],
    schemasFetchedAt: 0,
    layout: { ...DEFAULT_LAYOUT }
  })
}

export async function setSessionMeta(meta: SessionMeta): Promise<void> {
  await writeJson(path.join(sessionDir(meta.connectionId), 'meta.json'), meta)
}

export async function loadTabs(connectionId: string): Promise<QueryTabState[]> {
  const meta = await getSessionMeta(connectionId)
  const dir = path.join(sessionDir(connectionId), 'tabs')

  let files: string[] = []
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }

  const tabs = await Promise.all(
    files.map((f) => readJson<QueryTabState | null>(path.join(dir, f), null))
  )
  const found = tabs.filter((t): t is QueryTabState => t !== null)

  // Restore the order the user left them in; anything not in meta goes last.
  const order = new Map(meta.tabIds.map((id, i) => [id, i]))
  found.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER))
  return found
}

export async function saveTab(
  connectionId: string,
  tab: QueryTabState,
  maxTabSize: number
): Promise<void> {
  // Oversized tabs are still saved, minus the parts that made them oversized.
  let payload = tab
  const sqlTooBig = tab.sql.length > maxTabSize
  const resultSize = tab.result ? tab.result.rows.length * Math.max(1, tab.result.columns.length) : 0
  const resultTooBig = resultSize > maxTabSize

  if (sqlTooBig || resultTooBig) {
    payload = {
      ...tab,
      sql: sqlTooBig ? tab.sql.slice(0, maxTabSize) : tab.sql,
      result: resultTooBig ? null : tab.result
    }
  }

  await writeJson(path.join(sessionDir(connectionId), 'tabs', `${safeId(tab.id)}.json`), payload)
}

export async function deleteTab(connectionId: string, tabId: string): Promise<void> {
  await fsp
    .rm(path.join(sessionDir(connectionId), 'tabs', `${safeId(tabId)}.json`), { force: true })
    .catch(() => undefined)
}

export function userDataPath(): string {
  return rootDir
}
