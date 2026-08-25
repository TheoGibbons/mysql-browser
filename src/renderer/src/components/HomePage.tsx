import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionConfig, ConnectionGroup } from '@shared/types'
import { useAppStore } from '../store'
import { useContextMenu } from './ui/ContextMenu'
import { ExportIcon, ImportIcon, NewGroupIcon, PlusIcon, SearchIcon } from './ui/Icons'
import { AboutDialog } from './AboutDialog'
import { ConnectionDialog } from './ConnectionDialog'
import { ExportOptionsDialog, ImportPassphraseDialog } from './PassphraseDialogs'
import { Marquee } from './ui/Marquee'
import { Modal } from './ui/Modal'
import { newId } from '../lib/ids'
import { isValidHex, readableDimColor, readableTextColor } from '../lib/color'

/** A parsed export file, before the main process validates any of it. */
interface ImportPayload {
  connections?: unknown
  groups?: unknown
  secrets?: unknown
}

function endpoint(config: ConnectionConfig): string {
  const server =
    config.method === 'ssh'
      ? `${config.sshUser ? `${config.sshUser}@` : ''}${config.sshHost ?? ''} → ${config.host}:${config.port}`
      : `${config.host}:${config.port}`
  // A Postgres connection is pinned to one database, so which one is part of
  // identifying the connection in a way a MySQL host:port is not.
  const database = config.engine === 'postgres' ? config.database?.trim() : ''
  return database ? `${server}/${database}` : server
}

function methodBadge(config: ConnectionConfig): string | null {
  const method =
    config.method === 'ssh' ? 'SSH' : config.method === 'iam' ? 'AWS IAM' : null
  // Existing MySQL cards keep the badge they have always had; only Postgres
  // needs calling out, because it is the new thing on the screen.
  if (config.engine !== 'postgres') return method
  return method ? `PG · ${method}` : 'PG'
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

/**
 * What the pointer is carrying. `dataTransfer` payloads can't be read during
 * `dragover` (only on drop), so the item being dragged is kept in React state
 * and the native data is set purely so the drag is well-formed.
 */
type DragItem = { kind: 'conn'; id: string } | { kind: 'group'; id: string }

/** Where a drop would land, used to draw the insertion marker. */
type DropHint =
  | { kind: 'conn'; overId: string; before: boolean }
  | { kind: 'group'; overId: string; before: boolean }
  /** Open space inside a group (`groupId`) or the ungrouped area (`null`). */
  | { kind: 'zone'; groupId: string | null }

/**
 * Cheap identity for a hint. `dragover` fires continuously, so the marker is
 * only re-rendered once it actually moves somewhere else.
 */
function hintKey(hint: DropHint | null): string {
  if (!hint) return ''
  return hint.kind === 'zone'
    ? `zone:${hint.groupId ?? ''}`
    : `${hint.kind}:${hint.overId}:${hint.before}`
}

/**
 * Cards and groups flow left-to-right, so the horizontal midpoint of whatever
 * is under the pointer decides which side the item is inserted on.
 */
function droppingBefore(event: React.DragEvent<HTMLElement>): boolean {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientX - rect.left < rect.width / 2
}

/**
 * Returns the connection list with `dragId` moved into `groupId`, either beside
 * `target` or — when dropped on open space — at the end of that group.
 *
 * Display order is the array order (filtered per group when rendering), so a
 * single ordered list covers ordering within *and* between groups.
 */
function moveConnection(
  list: ConnectionConfig[],
  dragId: string,
  groupId: string | null,
  target: { id: string; before: boolean } | null
): ConnectionConfig[] {
  const dragged = list.find((c) => c.id === dragId)
  if (!dragged || target?.id === dragId) return list

  const rest = list.filter((c) => c.id !== dragId)
  const moved: ConnectionConfig = { ...dragged, groupId }

  if (target) {
    const index = rest.findIndex((c) => c.id === target.id)
    if (index >= 0) {
      rest.splice(target.before ? index : index + 1, 0, moved)
      return rest
    }
  }

  // Open space: sit after the group's last member (or at the very end when the
  // group is empty — nothing else in the list belongs to it).
  let last = -1
  rest.forEach((c, i) => {
    if ((c.groupId ?? null) === groupId) last = i
  })
  rest.splice(last >= 0 ? last + 1 : rest.length, 0, moved)
  return rest
}

function moveGroup(
  groups: ConnectionGroup[],
  dragId: string,
  targetId: string,
  before: boolean
): ConnectionGroup[] {
  if (dragId === targetId) return groups
  const dragged = groups.find((g) => g.id === dragId)
  if (!dragged) return groups

  const rest = groups.filter((g) => g.id !== dragId)
  const index = rest.findIndex((g) => g.id === targetId)
  if (index < 0) return groups
  rest.splice(before ? index : index + 1, 0, dragged)
  return rest
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

interface CardProps {
  config: ConnectionConfig
  draggable: boolean
  dragging: boolean
  /** Which edge the insertion marker sits on, if this card is the drop target. */
  hint: 'before' | 'after' | null
  onOpen(): void
  onContextMenu(event: React.MouseEvent): void
  onDragStart(): void
  onDragEnd(): void
  onDragOver(event: React.DragEvent<HTMLElement>): void
  onDrop(event: React.DragEvent<HTMLElement>): void
}

function ConnectionCard({
  config,
  draggable,
  dragging,
  hint,
  onOpen,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop
}: CardProps): JSX.Element {
  const badge = methodBadge(config)
  const colored = isValidHex(config.color)
  const cardStyle = colored
    ? {
        background: config.color,
        borderColor: 'rgba(0,0,0,0.25)',
        color: readableTextColor(config.color!)
      }
    : undefined
  const metaStyle = colored ? { color: readableDimColor(config.color!) } : undefined

  const classes = ['conn-card']
  if (colored) classes.push('colored')
  if (badge) classes.push('has-badge')
  if (dragging) classes.push('dragging')
  if (hint) classes.push(`drop-${hint}`)

  return (
    <div
      className={classes.join(' ')}
      style={cardStyle}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', config.id)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      title={
        draggable
          ? 'Double-click to open · drag to move or group · right-click for more'
          : 'Double-click to open · right-click for more'
      }
    >
      <h3 style={colored ? { color: readableTextColor(config.color!) } : undefined}>
        {config.name}
      </h3>
      <div className="meta" style={metaStyle}>
        👤 <Marquee>{config.user || '—'}</Marquee>
      </div>
      <div className="meta" style={metaStyle}>
        🖧 <Marquee>{endpoint(config)}</Marquee>
      </div>
      {badge && <span className="badge">{badge}</span>}
    </div>
  )
}

/**
 * Import/Export split into a single trigger that opens on hover (and on click,
 * for anyone driving it from the keyboard or a tap). It drops upwards because
 * it lives at the bottom of the home tab.
 */
function ImportExportMenu({
  onExport,
  onImport
}: {
  onExport(): void
  onImport(): void
}): JSX.Element {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (target?.closest('.menu-btn')) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const run = (action: () => void): void => {
    setOpen(false)
    action()
  }

  return (
    <div
      className="menu-btn"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {/* Click only ever opens: closing on click would fight the hover that
          re-opens it the moment the pointer is still over the trigger. */}
      <button
        className="btn"
        title="Export or import all connections"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        Import / Export <span className="menu-btn-caret">▾</span>
      </button>
      {open && (
        // The outer element reaches down to the button so the pointer never
        // crosses a gap on its way to the items; the visible panel is inset.
        <div className="menu-btn-pop">
          <div className="menu-btn-panel" role="menu">
            <button
              className="menu-btn-item"
              role="menuitem"
              title="Export all connections and groups to a JSON file, optionally including passwords"
              onClick={() => run(onExport)}
            >
              <ExportIcon size={13} /> Export all connections
            </button>
            <button
              className="menu-btn-item"
              role="menuitem"
              title="Import connections and groups from a JSON file"
              onClick={() => run(onImport)}
            >
              <ImportIcon size={13} /> Import all connections
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function HomePage(): JSX.Element {
  const connections = useAppStore((s) => s.connections)
  const setConnections = useAppStore((s) => s.setConnections)
  const groups = useAppStore((s) => s.groups)
  const setGroups = useAppStore((s) => s.setGroups)
  const openConnection = useAppStore((s) => s.openConnection)
  const menu = useContextMenu()

  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<ConnectionConfig | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<ConnectionConfig | null>(null)
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<ConnectionGroup | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [exportPrompt, setExportPrompt] = useState(false)
  const [about, setAbout] = useState(false)
  /** Set when the chosen import file carries passwords and needs a passphrase. */
  const [importPrompt, setImportPrompt] = useState<{
    payload: ImportPayload
    error: string | null
    busy: boolean
  } | null>(null)
  const [drag, setDrag] = useState<DragItem | null>(null)
  const [dropHint, setDropHint] = useState<DropHint | null>(null)
  /** The live payload. `drag` is the same thing, one tick behind — see `beginDrag`. */
  const dragRef = useRef<DragItem | null>(null)

  /** Written to the file once the export options dialog has been answered. */
  const writeExport = async (passphrase?: string): Promise<void> => {
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
      `_${pad(now.getHours())}-${pad(now.getMinutes())}`
    let data: Awaited<ReturnType<typeof window.api.connections.exportAll>>
    try {
      data = await window.api.connections.exportAll(passphrase)
    } catch (err) {
      setNotice(`Export failed: ${(err as Error).message}`)
      return
    }
    if (data.connections.length === 0) {
      setNotice('There are no connections to export.')
      return
    }
    const envelope = {
      app: 'mysql-browser',
      type: 'connections',
      version: 3,
      exportedAt: new Date().toISOString(),
      groups: data.groups,
      connections: data.connections,
      // Present only when passwords were included.
      ...(data.secrets ? { secrets: data.secrets } : {})
    }
    const target = await window.api.dialog.saveFile(
      'Export connections',
      `${stamp}_mysql-browser-connections.json`,
      [{ name: 'JSON', extensions: ['json'] }]
    )
    if (!target) return
    try {
      await window.api.files.write(target, JSON.stringify(envelope, null, 2))
      const groupNote =
        data.groups.length > 0 ? ` in ${plural(data.groups.length, 'group')}` : ''
      const passwordNote = data.secrets
        ? ` Passwords for ${plural(data.withSecrets, 'connection')} are included, encrypted with your passphrase.`
        : ' Passwords were not included.'
      setNotice(
        `Exported ${plural(data.connections.length, 'connection')}${groupNote}.${passwordNote}`
      )
    } catch (err) {
      setNotice(`Export failed: ${(err as Error).message}`)
    }
  }

  /** Applies a parsed payload; a wrong passphrase writes nothing, so retrying is free. */
  const applyImport = async (
    payload: ImportPayload,
    passphrase?: string
  ): Promise<'ok' | 'bad-passphrase'> => {
    try {
      const result = await window.api.connections.importAll(payload, passphrase)
      if ('badPassphrase' in result) return 'bad-passphrase'
      setConnections(result.connections)
      setGroups(result.groups)
      const parts = [`${result.added} added`, `${result.updated} updated`]
      if (result.skipped > 0) parts.push(`${result.skipped} skipped`)
      const passwordNote =
        result.restored > 0
          ? ` Passwords restored for ${plural(result.restored, 'connection')}.`
          : " Open each new connection's Edit dialog to set its password."
      setNotice(`Imported: ${parts.join(', ')}.${passwordNote}`)
      return 'ok'
    } catch (err) {
      setNotice(`Import failed: ${(err as Error).message}`)
      return 'ok'
    }
  }

  const importConnections = async (): Promise<void> => {
    const source = await window.api.dialog.openFile('Import connections', [
      { name: 'JSON', extensions: ['json'] },
      { name: 'All files', extensions: ['*'] }
    ])
    if (!source) return

    let payload: ImportPayload | null = null
    try {
      const text = await window.api.files.read(source)
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        payload = { connections: parsed.connections, groups: parsed.groups, secrets: parsed.secrets }
    } catch {
      setNotice('That file could not be read as a connections export (invalid JSON).')
      return
    }
    if (!payload || !Array.isArray(payload.connections)) {
      setNotice('That file does not contain a connections list.')
      return
    }

    // Passwords need the passphrase they were exported under; without a secrets
    // block there is nothing to unlock and the import goes straight through.
    if (payload.secrets) {
      setImportPrompt({ payload, error: null, busy: false })
      return
    }
    await applyImport(payload)
  }

  const filtering = filter.trim() !== ''

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return connections
    return connections.filter((c) =>
      [c.name, c.host, c.user, c.sshHost ?? '', String(c.port)]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    )
  }, [connections, filter])

  /** Visible cards split into their groups; anything pointing at a group that
      no longer exists falls back to the ungrouped area. */
  const { members, ungrouped } = useMemo(() => {
    const members = new Map<string, ConnectionConfig[]>(groups.map((g) => [g.id, []]))
    const ungrouped: ConnectionConfig[] = []
    for (const config of filtered) {
      const bucket = config.groupId ? members.get(config.groupId) : undefined
      if (bucket) bucket.push(config)
      else ungrouped.push(config)
    }
    return { members, ungrouped }
  }, [filtered, groups])

  // ------------------------------------------------------------- mutations

  /** Persists the whole display order + membership, showing it immediately. */
  const persistArrangement = async (next: ConnectionConfig[]): Promise<void> => {
    setConnections(next)
    try {
      setConnections(
        await window.api.connections.arrange(
          next.map((c) => ({ id: c.id, groupId: c.groupId ?? null }))
        )
      )
    } catch (err) {
      setNotice(`Could not save the new arrangement: ${(err as Error).message}`)
      setConnections(await window.api.connections.list())
    }
  }

  const persistGroups = async (next: ConnectionGroup[]): Promise<void> => {
    setGroups(next)
    try {
      setGroups(await window.api.groups.save(next))
    } catch (err) {
      setNotice(`Could not save the groups: ${(err as Error).message}`)
      setGroups(await window.api.groups.list())
    }
  }

  const addGroup = (): void => {
    void persistGroups([...groups, { id: newId('group'), collapsed: false }])
  }

  const toggleGroup = (id: string): void => {
    void persistGroups(groups.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)))
  }

  const deleteGroup = async (id: string): Promise<void> => {
    try {
      const result = await window.api.groups.remove(id)
      setConnections(result.connections)
      setGroups(result.groups)
    } catch (err) {
      setNotice(`Could not delete the group: ${(err as Error).message}`)
    } finally {
      setConfirmDeleteGroup(null)
    }
  }

  // ----------------------------------------------------------- drag and drop

  const canDrag = !filtering

  /**
   * Chromium abandons a drag whose `dragstart` handler relayouts the page — and
   * revealing the ungrouped drop zone does exactly that when every connection
   * already sits in a group. So the payload lands in a ref (which the later
   * handlers read) and everything that affects rendering is deferred until the
   * drag is already under way.
   */
  const beginDrag = (item: DragItem): void => {
    dragRef.current = item
    setTimeout(() => {
      if (dragRef.current === item) setDrag(item)
    }, 0)
  }

  const endDrag = (): void => {
    dragRef.current = null
    setDrag(null)
    setDropHint(null)
  }

  // A drag can still die without a `dragend` reaching its source (dropping onto
  // another window, for one), which would leave the card dimmed and the drop
  // zone stuck open. A drag session swallows mouse moves, so one arriving with
  // no button held means there is nothing in flight any more.
  useEffect(() => {
    if (!drag) return
    const onEnd = (): void => endDrag()
    const onMove = (event: MouseEvent): void => {
      // Only the visuals are reset: were this ever to fire mid-drag, clearing
      // the ref as well would break the drop it is meant to be rescuing.
      if (event.buttons === 0) {
        setDrag(null)
        setDropHint(null)
      }
    }
    // Bubble phase, never capture: these must run *after* the card and zone
    // handlers, which read the payload this clears.
    window.addEventListener('dragend', onEnd)
    window.addEventListener('drop', onEnd)
    window.addEventListener('mousemove', onMove, true)
    return () => {
      window.removeEventListener('dragend', onEnd)
      window.removeEventListener('drop', onEnd)
      window.removeEventListener('mousemove', onMove, true)
    }
  }, [drag])

  const showHint = (next: DropHint): void => {
    setDropHint((current) => (hintKey(current) === hintKey(next) ? current : next))
  }

  /** Hovering a card: insert the dragged connection beside it. */
  const onCardDragOver = (event: React.DragEvent<HTMLElement>, over: ConnectionConfig): void => {
    const item = dragRef.current
    if (item?.kind !== 'conn') return
    // The card owns this pointer position, so the zone underneath must not also
    // claim it — including when it is the card being dragged (no self-drop).
    event.stopPropagation()
    if (item.id === over.id) {
      setDropHint(null)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    showHint({ kind: 'conn', overId: over.id, before: droppingBefore(event) })
  }

  const onCardDrop = (event: React.DragEvent<HTMLElement>, over: ConnectionConfig): void => {
    const item = dragRef.current
    if (item?.kind !== 'conn' || item.id === over.id) return
    event.preventDefault()
    event.stopPropagation()
    const before = droppingBefore(event)
    void persistArrangement(
      moveConnection(connections, item.id, over.groupId ?? null, { id: over.id, before })
    )
    endDrag()
  }

  /** Hovering the open space of a group (or the ungrouped area). */
  const onZoneDragOver = (event: React.DragEvent<HTMLElement>, groupId: string | null): void => {
    if (dragRef.current?.kind !== 'conn') return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    showHint({ kind: 'zone', groupId })
  }

  const onZoneDrop = (event: React.DragEvent<HTMLElement>, groupId: string | null): void => {
    const item = dragRef.current
    if (item?.kind !== 'conn') return
    event.preventDefault()
    void persistArrangement(moveConnection(connections, item.id, groupId, null))
    endDrag()
  }

  /** Hovering a group while dragging another group: reorder the board. */
  const onGroupDragOver = (event: React.DragEvent<HTMLElement>, over: ConnectionGroup): void => {
    const item = dragRef.current
    if (item?.kind !== 'group' || item.id === over.id) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    showHint({ kind: 'group', overId: over.id, before: droppingBefore(event) })
  }

  const onGroupDrop = (event: React.DragEvent<HTMLElement>, over: ConnectionGroup): void => {
    const item = dragRef.current
    if (item?.kind !== 'group' || item.id === over.id) return
    event.preventDefault()
    void persistGroups(moveGroup(groups, item.id, over.id, droppingBefore(event)))
    endDrag()
  }

  const onCardContextMenu = (event: React.MouseEvent, config: ConnectionConfig): void => {
    event.preventDefault()
    const inGroup = groups.some((g) => g.id === config.groupId)
    menu.show(event, [
      { label: 'Open Connection', onSelect: () => void openConnection(config, true) },
      {
        label: 'Open Offline (cached schemas and tabs)',
        onSelect: () => void openConnection(config, false)
      },
      { separator: true },
      { label: 'Edit Connection…', onSelect: () => setEditing(config) },
      {
        label: 'Duplicate Connection',
        onSelect: () => {
          setEditing({
            ...config,
            id: '',
            name: `${config.name} (copy)`,
            createdAt: Date.now()
          })
        }
      },
      ...(inGroup
        ? [
            { separator: true as const },
            {
              label: 'Remove from Group',
              onSelect: () =>
                void persistArrangement(moveConnection(connections, config.id, null, null))
            }
          ]
        : []),
      { separator: true },
      { label: 'Delete Connection…', onSelect: () => setConfirmDelete(config) }
    ])
  }

  const renderCard = (config: ConnectionConfig): JSX.Element => (
    <ConnectionCard
      key={config.id}
      config={config}
      draggable={canDrag}
      dragging={drag?.kind === 'conn' && drag.id === config.id}
      hint={
        dropHint?.kind === 'conn' && dropHint.overId === config.id
          ? dropHint.before
            ? 'before'
            : 'after'
          : null
      }
      onOpen={() => void openConnection(config, true)}
      onContextMenu={(e) => onCardContextMenu(e, config)}
      onDragStart={() => beginDrag({ kind: 'conn', id: config.id })}
      onDragEnd={endDrag}
      onDragOver={(e) => onCardDragOver(e, config)}
      onDrop={(e) => onCardDrop(e, config)}
    />
  )

  const renderGroup = (group: ConnectionGroup): JSX.Element => {
    const cards = members.get(group.id) ?? []
    // A filter has to be able to reveal matches inside a collapsed group.
    const expanded = !group.collapsed || filtering
    const classes = ['conn-group']
    if (!expanded) classes.push('collapsed')
    if (drag?.kind === 'group' && drag.id === group.id) classes.push('dragging')
    if (dropHint?.kind === 'zone' && dropHint.groupId === group.id) classes.push('drop-target')
    if (dropHint?.kind === 'group' && dropHint.overId === group.id) {
      classes.push(dropHint.before ? 'drop-before' : 'drop-after')
    }

    return (
      <section
        key={group.id}
        className={classes.join(' ')}
        onDragOver={(e) => onGroupDragOver(e, group)}
        onDrop={(e) => onGroupDrop(e, group)}
      >
        <header
          className="conn-group-head"
          draggable={canDrag}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', group.id)
            beginDrag({ kind: 'group', id: group.id })
          }}
          onDragEnd={endDrag}
          title={canDrag ? 'Drag to reorder this group' : undefined}
        >
          <button
            className="group-toggle"
            title={expanded ? 'Collapse group' : 'Expand group'}
            aria-expanded={expanded}
            onClick={() => toggleGroup(group.id)}
          >
            {expanded ? '−' : '+'}
          </button>
          <span className="group-count">{plural(cards.length, 'connection')}</span>
          <span className="group-grip" aria-hidden>
            ⣿
          </span>
          <div className="spacer" />
          <button
            className="icon-btn"
            title="Delete group and everything in it…"
            style={{ width: 18, height: 18 }}
            onClick={() => setConfirmDeleteGroup(group)}
          >
            ×
          </button>
        </header>

        {expanded && (
          <div
            className="conn-group-body"
            onDragOver={(e) => onZoneDragOver(e, group.id)}
            onDrop={(e) => onZoneDrop(e, group.id)}
          >
            {cards.length === 0 ? (
              <div className="zone-empty">Drag connections here</div>
            ) : (
              <div className="conn-grid">{cards.map(renderCard)}</div>
            )}
          </div>
        )}
      </section>
    )
  }

  const visibleGroups = filtering
    ? groups.filter((g) => (members.get(g.id) ?? []).length > 0)
    : groups
  const nothingToShow = filtered.length === 0 && visibleGroups.length === 0

  return (
    <div className="home">
      <div className="home-head">
        <h1>Connections</h1>
        <button
          className="icon-btn"
          title="Add new connection"
          onClick={() => setCreating(true)}
          style={{ width: 22, height: 22 }}
        >
          <PlusIcon size={16} />
        </button>
        <button
          className="icon-btn"
          title="Add group"
          onClick={addGroup}
          style={{ width: 22, height: 22 }}
        >
          <NewGroupIcon size={16} />
        </button>
        <div className="spacer" />
        <div className="row" style={{ gap: 5 }}>
          <SearchIcon />
          <input
            className="filter-input"
            style={{ width: 220 }}
            placeholder="Filter connections"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      {notice && (
        <div className="banner info" style={{ borderRadius: 3, marginBottom: 12 }}>
          <span style={{ flex: 1 }}>{notice}</span>
          <button
            className="icon-btn"
            title="Dismiss"
            style={{ width: 18, height: 18 }}
            onClick={() => setNotice(null)}
          >
            ×
          </button>
        </div>
      )}

      {connections.length === 0 && groups.length === 0 ? (
        <div className="home-empty">
          No connections yet.
          <br />
          Click the <strong>+</strong> above to add one.
        </div>
      ) : nothingToShow ? (
        <div className="home-empty">No connections match “{filter}”.</div>
      ) : (
        <>
          {/* Ungrouped cards sit at the top; the zone stays droppable while a
              card is in flight so a connection can be pulled out of a group. */}
          {(ungrouped.length > 0 || drag?.kind === 'conn') && (
            <div
              className={`conn-zone${
                dropHint?.kind === 'zone' && dropHint.groupId === null ? ' drop-target' : ''
              }`}
              onDragOver={(e) => onZoneDragOver(e, null)}
              onDrop={(e) => onZoneDrop(e, null)}
            >
              {ungrouped.length === 0 ? (
                <div className="zone-empty">Drop here to take a connection out of its group</div>
              ) : (
                <div className="conn-grid">{ungrouped.map(renderCard)}</div>
              )}
            </div>
          )}

          {visibleGroups.length > 0 && (
            <div className="group-board">{visibleGroups.map(renderGroup)}</div>
          )}
        </>
      )}

      <div className="home-foot">
        <button className="btn" title="Version and build details" onClick={() => setAbout(true)}>
          About
        </button>
        <div className="spacer" />
        <ImportExportMenu
          onExport={() => setExportPrompt(true)}
          onImport={() => void importConnections()}
        />
      </div>

      {(creating || editing) && (
        <ConnectionDialog
          initial={editing ?? undefined}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
          onSaved={(next) => {
            setConnections(next)
            setCreating(false)
            setEditing(null)
          }}
        />
      )}

      {about && <AboutDialog onClose={() => setAbout(false)} />}

      {exportPrompt && (
        <ExportOptionsDialog
          connectionCount={connections.length}
          onCancel={() => setExportPrompt(false)}
          onExport={(passphrase) => {
            setExportPrompt(false)
            void writeExport(passphrase)
          }}
        />
      )}

      {importPrompt && (
        <ImportPassphraseDialog
          error={importPrompt.error}
          busy={importPrompt.busy}
          onCancel={() => setImportPrompt(null)}
          onSkip={() => {
            const { payload } = importPrompt
            setImportPrompt(null)
            void applyImport(payload)
          }}
          onSubmit={async (passphrase) => {
            setImportPrompt((p) => (p ? { ...p, busy: true, error: null } : p))
            const outcome = await applyImport(importPrompt.payload, passphrase)
            if (outcome === 'bad-passphrase') {
              // Nothing was written, so the dialog just stays up for another go.
              setImportPrompt((p) =>
                p ? { ...p, busy: false, error: 'That passphrase does not match this file.' } : p
              )
            } else {
              setImportPrompt(null)
            }
          }}
        />
      )}

      {confirmDelete && (
        <Modal
          title="Delete connection"
          width={420}
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <div className="spacer" />
              <button className="btn" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  const next = await window.api.connections.remove(confirmDelete.id)
                  setConnections(next)
                  setConfirmDelete(null)
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <p style={{ margin: 0, lineHeight: 1.6 }}>
            Delete <strong>{confirmDelete.name}</strong>?
            <br />
            <span className="hint">
              Its saved tabs and cached schema list will be removed too. The database itself is not
              touched.
            </span>
          </p>
        </Modal>
      )}

      {confirmDeleteGroup && (
        <Modal
          title="Delete group"
          width={440}
          onClose={() => setConfirmDeleteGroup(null)}
          footer={
            <>
              <div className="spacer" />
              <button className="btn" onClick={() => setConfirmDeleteGroup(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => void deleteGroup(confirmDeleteGroup.id)}
              >
                Delete
              </button>
            </>
          }
        >
          {(() => {
            const doomed = connections.filter((c) => c.groupId === confirmDeleteGroup.id)
            return (
              <div style={{ lineHeight: 1.6 }}>
                {doomed.length === 0 ? (
                  <p style={{ margin: 0 }}>Delete this empty group?</p>
                ) : (
                  <>
                    <p style={{ margin: 0 }}>
                      Deleting this group also deletes the {plural(doomed.length, 'connection')}{' '}
                      inside it:
                    </p>
                    <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                      {doomed.map((c) => (
                        <li key={c.id}>{c.name}</li>
                      ))}
                    </ul>
                    <p className="hint" style={{ margin: '8px 0 0' }}>
                      Their saved tabs and cached schema lists go too. The databases themselves are
                      not touched. Drag a connection out of the group first to keep it.
                    </p>
                  </>
                )}
              </div>
            )
          })()}
        </Modal>
      )}
    </div>
  )
}
