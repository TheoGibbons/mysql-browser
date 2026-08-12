/**
 * File-backed storage under the app's userData directory.
 *
 *   connections.json                    saved connections (secrets encrypted)
 *   groups.json                         home-screen groups, in display order
 *   preferences.json                    global preferences
 *   tools.json                          dump tool paths and last-used directories
 *   sessions/<connectionId>/meta.json   schema cache, open tabs, layout
 *   sessions/<connectionId>/tabs/*.json one file per tab (spec: one file per tab)
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import {
  DEFAULT_HISTORY_COLUMNS,
  DEFAULT_LAYOUT,
  DEFAULT_PREFERENCES,
  DEFAULT_TOOL_SETTINGS,
  toEngine,
  type ConnectionConfig,
  type ConnectionGroup,
  type ConnectionSecretsEnvelope,
  type Preferences,
  type QueryTabState,
  type SessionMeta,
  type ToolSettings
} from '@shared/types'

/** Marks a value as ciphertext so plaintext fallbacks stay readable. */
const ENC_PREFIX = 'enc:v1:'
/**
 * Fields encrypted at rest and carried in an export's secrets envelope.
 * `sshKeyFile` is deliberately not one of them: it is a path, not a secret, and
 * it travels as plaintext so the user can see and fix it after moving machines.
 */
const SECRET_FIELDS = ['password', 'sshPassword', 'sshPassphrase'] as const

type SecretField = (typeof SECRET_FIELDS)[number]

let rootDir = ''

export async function initStore(): Promise<void> {
  rootDir = app.getPath('userData')
  fs.mkdirSync(path.join(rootDir, 'sessions'), { recursive: true })
  await migrateConnectionEngines()
  await migrateSessionMeta()
  await migrateToolSettings()
}

/**
 * Connections saved before PostgreSQL support have no `engine`. Filling it in
 * once, before anything else reads the file, is what lets every other path take
 * the field as given rather than defaulting it on each read. Entries are
 * rewritten as stored, so their encrypted secrets are untouched.
 */
async function migrateConnectionEngines(): Promise<void> {
  const stored = await readJson<ConnectionConfig[]>(file('connections.json'), [])
  const stale = stored.filter((c) => c.engine !== 'mysql' && c.engine !== 'postgres')
  if (stale.length === 0) return
  for (const connection of stale) connection.engine = 'mysql'
  await writeJson(file('connections.json'), stored)
  console.log(`Migrated ${stale.length} connection(s) to an explicit engine.`)
}

/**
 * Session files written before the layout and the resizable history columns
 * existed are missing fields that `SessionMeta` now declares. Completing them
 * once, at startup, is what lets readers take the shape as given.
 */
async function migrateSessionMeta(): Promise<void> {
  const root = file('sessions')
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => [])
  let migrated = 0

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const metaFile = path.join(root, entry.name, 'meta.json')
    const stored = await readJson<Partial<SessionMeta> | null>(metaFile, null)
    if (!stored) continue

    const complete = completeSessionMeta(stored, stored.connectionId ?? entry.name)
    if (JSON.stringify(complete) === JSON.stringify(stored)) continue
    await writeJson(metaFile, complete)
    migrated++
  }

  if (migrated > 0) console.log(`Migrated ${migrated} session file(s) to the current shape.`)
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

// --- portable secrets (export files) ---------------------------------------

interface ScryptParams {
  N: number
  r: number
  p: number
  keyLength: number
}

/** ~32 MB and a few hundred ms to derive — deliberately slow to brute-force. */
const SCRYPT: ScryptParams = { N: 32768, r: 8, p: 1, keyLength: 32 }
const SCRYPT_MAXMEM = 96 * 1024 * 1024

/**
 * Thrown when the passphrase cannot open an export's secrets envelope. Never
 * leaves this module — `importConnections` turns it into a returned outcome.
 */
class PassphraseError extends Error {
  readonly code = 'BAD_PASSPHRASE'
  constructor(message: string) {
    super(message)
    this.name = 'PassphraseError'
  }
}

type SecretsMap = Record<string, Partial<Record<SecretField, string>>>

function deriveKey(passphrase: string, salt: Buffer, params: ScryptParams): Buffer {
  // NFKC so a passphrase typed on another machine/keyboard derives the same key.
  return scryptSync(passphrase.normalize('NFKC'), salt, params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM
  })
}

function sealSecrets(secrets: SecretsMap, passphrase: string): ConnectionSecretsEnvelope {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt, SCRYPT), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()])
  return {
    v: 1,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    keyLength: SCRYPT.keyLength,
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }
}

function openSecrets(envelope: unknown, passphrase: string): SecretsMap {
  const e = envelope as Partial<ConnectionSecretsEnvelope>
  if (!e || typeof e !== 'object' || e.kdf !== 'scrypt' || e.cipher !== 'aes-256-gcm') {
    throw new Error('This export stores its passwords in a format this version cannot read.')
  }
  // The parameters come from the file, so they are only trusted within reason —
  // an absurd N would otherwise be a way to hang the app on a hostile export.
  const params = {
    N: typeof e.N === 'number' ? e.N : SCRYPT.N,
    r: typeof e.r === 'number' ? e.r : SCRYPT.r,
    p: typeof e.p === 'number' ? e.p : SCRYPT.p,
    keyLength: 32
  }
  if (params.N < 1024 || params.N > 1 << 20 || params.r < 1 || params.r > 32 || params.p < 1 || params.p > 16) {
    throw new Error('This export declares key-derivation settings outside the supported range.')
  }

  let json: string
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveKey(passphrase, Buffer.from(String(e.salt), 'base64'), params),
      Buffer.from(String(e.iv), 'base64')
    )
    decipher.setAuthTag(Buffer.from(String(e.tag), 'base64'))
    json = Buffer.concat([
      decipher.update(Buffer.from(String(e.data), 'base64')),
      decipher.final()
    ]).toString('utf8')
  } catch {
    // GCM cannot tell a wrong key from a tampered file, and for this feature the
    // first is overwhelmingly the likely one.
    throw new PassphraseError('That passphrase does not match this file.')
  }

  try {
    const parsed = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape')
    return parsed as SecretsMap
  } catch {
    throw new PassphraseError('That passphrase does not match this file.')
  }
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
  /** Present only when a passphrase was supplied. */
  secrets?: ConnectionSecretsEnvelope
  /** How many connections contributed at least one password to `secrets`. */
  withSecrets: number
}

/**
 * All connections and groups, ready to serialise to a file. Secrets never sit
 * in the connection objects themselves; with a passphrase they are collected
 * into a separate encrypted envelope, and without one they are simply dropped.
 */
export async function exportConnections(passphrase?: string): Promise<ConnectionsExport> {
  const all = await listConnections()
  const connections = all.map((c) => {
    const copy = { ...c }
    for (const key of SECRET_FIELDS) delete copy[key]
    return copy
  })
  const groups = await listGroups()
  if (!passphrase) return { connections, groups, withSecrets: 0 }

  const secrets: SecretsMap = {}
  let withSecrets = 0
  for (const c of all) {
    const entry: Partial<Record<SecretField, string>> = {}
    for (const key of SECRET_FIELDS) {
      const value = c[key]
      if (typeof value === 'string' && value !== '') entry[key] = value
    }
    if (Object.keys(entry).length > 0) {
      secrets[c.id] = entry
      withSecrets++
    }
  }
  return { connections, groups, secrets: sealSecrets(secrets, passphrase), withSecrets }
}

export interface ImportResult {
  connections: ConnectionConfig[]
  groups: ConnectionGroup[]
  added: number
  updated: number
  skipped: number
  /** Connections that got at least one password back from the secrets envelope. */
  restored: number
}

/**
 * A wrong passphrase is an expected, retryable outcome rather than a failure,
 * and it is reported as a value: a thrown error would lose its `code` crossing
 * the context bridge, which reconstructs Errors from message and stack alone.
 */
export interface ImportRejected {
  badPassphrase: true
}

/**
 * Merges imported connections by id. Existing secrets are preserved when the
 * imported entry has none (an export without a passphrase carries none), so
 * re-importing never wipes a saved password. Unknown/invalid entries are
 * skipped.
 *
 * A `secrets` envelope is opened with `passphrase` before anything is written,
 * so a wrong passphrase leaves the stored connections untouched and can just be
 * retried.
 */
export async function importConnections(
  incoming: unknown,
  passphrase?: string
): Promise<ImportResult | ImportRejected> {
  const payload = (incoming ?? {}) as {
    connections?: unknown
    groups?: unknown
    secrets?: unknown
  }
  const items = Array.isArray(payload.connections) ? payload.connections : []

  // Decrypt up front: nothing below this point should run on a bad passphrase.
  let unsealed: SecretsMap = {}
  if (payload.secrets && passphrase) {
    try {
      unsealed = openSecrets(payload.secrets, passphrase)
    } catch (err) {
      if (err instanceof PassphraseError) return { badPassphrase: true }
      throw err
    }
  }

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
  let restored = 0

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
      engine: toEngine(cleaned.engine),
      createdAt: existing?.createdAt ?? (typeof cfg.createdAt === 'number' ? cfg.createdAt : Date.now())
    } as ConnectionConfig

    // A group reference only survives if that group actually exists after the
    // merge; otherwise the connection lands in the ungrouped area.
    merged.groupId = typeof merged.groupId === 'string' && groupsById.has(merged.groupId)
      ? merged.groupId
      : null

    // Secrets only ever come from the envelope this import just decrypted;
    // otherwise keep whatever the existing connection already had.
    const sealed = unsealed[id] ?? {}
    let restoredHere = false
    for (const key of SECRET_FIELDS) {
      const fromEnvelope = sealed[key]
      if (typeof fromEnvelope === 'string' && fromEnvelope !== '') {
        merged[key] = fromEnvelope
        restoredHere = true
      } else if (existing) {
        merged[key] = existing[key]
      } else {
        delete merged[key]
      }
    }
    if (restoredHere) restored++

    byId.set(id, merged)
    if (existing) updated++
    else added++
  })

  const plain = [...byId.values()]
  await writeJson(file('connections.json'), plain.map(protect))
  await writeJson(file('groups.json'), groups)
  return { connections: plain, groups, added, updated, skipped, restored }
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
// External tools
// ---------------------------------------------------------------------------

/** Keys that were preferences before Data Export/Import owned them. */
const MOVED_TOOL_KEYS = ['mysqldumpPath', 'mysqlPath', 'exportDirectory'] as const

/**
 * The dump tool paths and the export directory used to be preferences, set up
 * front in a dialog. They are now remembered as they are used, so an existing
 * installation's values are carried across once and removed from the files that
 * no longer describe them — including any per-connection overrides, which would
 * otherwise reappear as phantom preference overrides forever.
 */
async function migrateToolSettings(): Promise<void> {
  const prefs = await readJson<Record<string, unknown>>(file('preferences.json'), {})
  const present = MOVED_TOOL_KEYS.filter((key) => key in prefs)

  if (present.length > 0) {
    const stored = await readJson<Partial<ToolSettings>>(file('tools.json'), {})
    const next = { ...stored }
    for (const key of present) {
      const value = prefs[key]
      if (typeof value === 'string' && value !== '' && !next[key]) next[key] = value
      delete prefs[key]
    }
    await writeJson(file('tools.json'), { ...DEFAULT_TOOL_SETTINGS, ...next })
    await writeJson(file('preferences.json'), prefs)
    console.log(`Moved ${present.length} tool setting(s) out of preferences.`)
  }

  // Stored connections keep their secrets encrypted, so this rewrites the raw
  // entries rather than going through listConnections/saveConnection.
  const connections = await readJson<ConnectionConfig[]>(file('connections.json'), [])
  let touched = 0
  for (const connection of connections) {
    const overrides = connection.prefs as Record<string, unknown> | undefined
    if (!overrides) continue
    for (const key of MOVED_TOOL_KEYS) {
      if (key in overrides) {
        delete overrides[key]
        touched++
      }
    }
  }
  if (touched > 0) {
    await writeJson(file('connections.json'), connections)
    console.log(`Cleared ${touched} stale tool override(s) from connections.`)
  }
}

export async function getToolSettings(): Promise<ToolSettings> {
  const stored = await readJson<Partial<ToolSettings>>(file('tools.json'), {})
  const merged = { ...DEFAULT_TOOL_SETTINGS, ...stored }
  // Somewhere to put the first dump before the user has chosen anywhere.
  if (!merged.exportDirectory) merged.exportDirectory = app.getPath('home')
  return merged
}

/** Merges a patch, so a tab can remember one field without knowing the rest. */
export async function setToolSettings(patch: Partial<ToolSettings>): Promise<ToolSettings> {
  const stored = await readJson<Partial<ToolSettings>>(file('tools.json'), {})
  const merged = { ...DEFAULT_TOOL_SETTINGS, ...stored, ...patch }
  await writeJson(file('tools.json'), merged)
  return getToolSettings()
}

// ---------------------------------------------------------------------------
// Session state (schema cache, tabs, layout)
// ---------------------------------------------------------------------------

function sessionDir(connectionId: string): string {
  return file('sessions', safeId(connectionId))
}

/** What a connection's session looks like before it has ever been opened. */
function blankSessionMeta(connectionId: string): SessionMeta {
  return {
    connectionId,
    tabIds: [],
    activeTabId: null,
    expandedSchemas: [],
    activeSchema: null,
    showSystemSchemas: false,
    schemas: [],
    schemasFetchedAt: 0,
    layout: { ...DEFAULT_LAYOUT, historyColumns: { ...DEFAULT_HISTORY_COLUMNS } }
  }
}

/** Fills in whatever a stored session file is missing, nested layout included. */
function completeSessionMeta(stored: Partial<SessionMeta>, connectionId: string): SessionMeta {
  const blank = blankSessionMeta(connectionId)
  return {
    ...blank,
    ...stored,
    connectionId,
    layout: {
      ...blank.layout,
      ...(stored.layout ?? {}),
      historyColumns: { ...blank.layout.historyColumns, ...(stored.layout?.historyColumns ?? {}) }
    }
  }
}

export async function getSessionMeta(connectionId: string): Promise<SessionMeta> {
  return readJson<SessionMeta>(
    path.join(sessionDir(connectionId), 'meta.json'),
    blankSessionMeta(connectionId)
  )
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
