/**
 * File-backed storage under the app's userData directory.
 *
 *   connections.json                    saved connections (secrets encrypted)
 *   groups.json                         home-screen groups, in display order
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
  engineOf,
  type ConnectionConfig,
  type ConnectionGroup,
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
  const out = { ...config, engine: engineOf(config) }
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

/**
 * Applies a home-screen arrangement in one write: `placements` is the complete
 * list of connection ids in display order, each with the group it now sits in.
 * Ids the renderer did not mention (e.g. added by another window mid-drag) keep
 * their data and are appended in their existing order.
 */
export async function arrangeConnections(
  placements: { id: string; groupId: string | null }[]
): Promise<ConnectionConfig[]> {
  const stored = await readJson<ConnectionConfig[]>(file('connections.json'), [])
  const remaining = new Map(stored.map((c) => [c.id, c]))

  const next: ConnectionConfig[] = []
  for (const placement of Array.isArray(placements) ? placements : []) {
    const existing = placement && remaining.get(placement.id)
    if (!existing) continue
    remaining.delete(placement.id)
    next.push({ ...existing, groupId: placement.groupId ?? null })
  }
  next.push(...remaining.values())

  await writeJson(file('connections.json'), next)
  return next.map(unprotect)
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/** Drops malformed/duplicate entries so a hand-edited file can't break the home screen. */
function cleanGroups(groups: unknown): ConnectionGroup[] {
  const byId = new Map<string, ConnectionGroup>()
  for (const raw of Array.isArray(groups) ? groups : []) {
    const group = raw as Partial<ConnectionGroup>
    if (!group || typeof group.id !== 'string' || group.id.trim() === '') continue
    byId.set(group.id, { id: group.id, collapsed: group.collapsed === true })
  }
  return [...byId.values()]
}

export async function listGroups(): Promise<ConnectionGroup[]> {
  return cleanGroups(await readJson<unknown>(file('groups.json'), []))
}

/** Full replace — adding, reordering and collapsing all come through here. */
export async function saveGroups(groups: unknown): Promise<ConnectionGroup[]> {
  const clean = cleanGroups(groups)
  await writeJson(file('groups.json'), clean)
  return clean
}

/** Removes a group *and* every connection inside it (the renderer confirms first). */
export async function deleteGroup(
  id: string
): Promise<{ connections: ConnectionConfig[]; groups: ConnectionGroup[] }> {
  const stored = await readJson<ConnectionConfig[]>(file('connections.json'), [])
  const kept = stored.filter((c) => c.groupId !== id)
  const removed = stored.filter((c) => c.groupId === id)
  await writeJson(file('connections.json'), kept)
  for (const config of removed) {
    await fsp
      .rm(file('sessions', safeId(config.id)), { recursive: true, force: true })
      .catch(() => undefined)
  }

  const groups = (await listGroups()).filter((g) => g.id !== id)
  await writeJson(file('groups.json'), groups)
  return { connections: kept.map(unprotect), groups }
}

// ---------------------------------------------------------------------------
// Import / export (connection definitions only — never tabs or schema cache)
// ---------------------------------------------------------------------------

export interface ConnectionsExport {
  connections: ConnectionConfig[]
  groups: ConnectionGroup[]
}

/** All connections and groups with secrets stripped, ready to serialise to a file. */
export async function exportConnections(): Promise<ConnectionsExport> {
  const connections = (await listConnections()).map((c) => {
    const copy = { ...c }
    for (const key of SECRET_FIELDS) delete copy[key]
    return copy
  })
  return { connections, groups: await listGroups() }
}

export interface ImportResult {
  connections: ConnectionConfig[]
  groups: ConnectionGroup[]
  added: number
  updated: number
  skipped: number
}

/**
 * Merges imported connections by id. Existing secrets are preserved when the
 * imported entry has none (the export strips them), so re-importing never wipes
 * a saved password. Unknown/invalid entries are skipped.
 *
 * Accepts either the current `{ connections, groups }` payload or a bare array
 * of connections (what exports before groups existed contained).
 */
export async function importConnections(incoming: unknown): Promise<ImportResult> {
  const payload = (Array.isArray(incoming) ? { connections: incoming } : incoming ?? {}) as {
    connections?: unknown
    groups?: unknown
  }
  const items = Array.isArray(payload.connections) ? payload.connections : []

  // Imported groups join the existing ones, keeping their own relative order.
  const groupsById = new Map((await listGroups()).map((g) => [g.id, g]))
  for (const group of cleanGroups(payload.groups)) {
    groupsById.set(group.id, { ...groupsById.get(group.id), ...group })
  }
  const groups = [...groupsById.values()]

  // Work in plaintext, then encrypt once on write.
  const byId = new Map<string, ConnectionConfig>()
  for (const c of await listConnections()) byId.set(c.id, c)

  let added = 0
  let updated = 0
  let skipped = 0

  items.forEach((item, index) => {
    const cfg = item as Partial<ConnectionConfig>
    if (!cfg || typeof cfg !== 'object' || typeof cfg.name !== 'string' || cfg.name.trim() === '') {
      skipped++
      return
    }

    const id =
      typeof cfg.id === 'string' && cfg.id.trim() !== ''
        ? cfg.id
        : `conn_import_${Date.now().toString(36)}_${index}`
    const existing = byId.get(id)

    // Non-secret fields come from the imported entry; strip secrets out of it.
    const cleaned: Record<string, unknown> = { ...cfg }
    for (const key of SECRET_FIELDS) delete cleaned[key]

    const merged: ConnectionConfig = {
      ...(existing ?? {}),
      ...(cleaned as Partial<ConnectionConfig>),
      id,
      name: cfg.name.trim(),
      engine: engineOf(cleaned as Partial<ConnectionConfig>),
      createdAt: existing?.createdAt ?? (typeof cfg.createdAt === 'number' ? cfg.createdAt : Date.now())
    } as ConnectionConfig

    // A group reference only survives if that group actually exists after the
    // merge; otherwise the connection lands in the ungrouped area.
    merged.groupId = typeof merged.groupId === 'string' && groupsById.has(merged.groupId)
      ? merged.groupId
      : null

    // Secrets: use an imported plaintext secret if one was included, else keep
    // whatever the existing connection already had.
    for (const key of SECRET_FIELDS) {
      const imported = (cfg as Record<string, unknown>)[key]
      if (typeof imported === 'string' && imported !== '' && !imported.startsWith(ENC_PREFIX)) {
        merged[key] = imported
      } else if (existing) {
        merged[key] = existing[key]
      } else {
        delete merged[key]
      }
    }

    byId.set(id, merged)
    if (existing) updated++
    else added++
  })

  const plain = [...byId.values()]
  await writeJson(file('connections.json'), plain.map(protect))
  await writeJson(file('groups.json'), groups)
  return { connections: plain, groups, added, updated, skipped }
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
