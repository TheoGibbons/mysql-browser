import { useMemo, useState } from 'react'
import type { ConnectionConfig } from '@shared/types'
import { useAppStore } from '../store'
import { useContextMenu } from './ui/ContextMenu'
import { ExportIcon, ImportIcon, PlusIcon, SearchIcon } from './ui/Icons'
import { ConnectionDialog } from './ConnectionDialog'
import { Marquee } from './ui/Marquee'
import { Modal } from './ui/Modal'
import { isValidHex, readableDimColor, readableTextColor } from '../lib/color'

function endpoint(config: ConnectionConfig): string {
  if (config.method === 'ssh') {
    return `${config.sshUser ? `${config.sshUser}@` : ''}${config.sshHost ?? ''} → ${config.host}:${config.port}`
  }
  return `${config.host}:${config.port}`
}

function methodBadge(config: ConnectionConfig): string | null {
  switch (config.method) {
    case 'ssh':
      return 'SSH'
    case 'iam':
      return 'AWS IAM'
    default:
      return null
  }
}

export function HomePage(): JSX.Element {
  const connections = useAppStore((s) => s.connections)
  const setConnections = useAppStore((s) => s.setConnections)
  const openConnection = useAppStore((s) => s.openConnection)
  const menu = useContextMenu()

  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<ConnectionConfig | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<ConnectionConfig | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const exportConnections = async (): Promise<void> => {
    const data = await window.api.connections.exportAll()
    if (data.length === 0) {
      setNotice('There are no connections to export.')
      return
    }
    const envelope = {
      app: 'mysql-browser',
      type: 'connections',
      version: 1,
      exportedAt: new Date().toISOString(),
      connections: data
    }
    const target = await window.api.dialog.saveFile(
      'Export connections',
      'mysql-browser-connections.json',
      [{ name: 'JSON', extensions: ['json'] }]
    )
    if (!target) return
    try {
      await window.api.files.write(target, JSON.stringify(envelope, null, 2))
      setNotice(`Exported ${data.length} connection${data.length === 1 ? '' : 's'} (without passwords).`)
    } catch (err) {
      setNotice(`Export failed: ${(err as Error).message}`)
    }
  }

  const importConnections = async (): Promise<void> => {
    const source = await window.api.dialog.openFile('Import connections', [
      { name: 'JSON', extensions: ['json'] },
      { name: 'All files', extensions: ['*'] }
    ])
    if (!source) return

    let items: unknown
    try {
      const text = await window.api.files.read(source)
      const parsed = JSON.parse(text)
      items = Array.isArray(parsed) ? parsed : (parsed?.connections ?? null)
    } catch {
      setNotice('That file could not be read as a connections export (invalid JSON).')
      return
    }
    if (!Array.isArray(items)) {
      setNotice('That file does not contain a connections list.')
      return
    }

    try {
      const result = await window.api.connections.importAll(items)
      setConnections(result.connections)
      const parts = [`${result.added} added`, `${result.updated} updated`]
      if (result.skipped > 0) parts.push(`${result.skipped} skipped`)
      setNotice(
        `Imported: ${parts.join(', ')}. Open each new connection's Edit dialog to set its password.`
      )
    } catch (err) {
      setNotice(`Import failed: ${(err as Error).message}`)
    }
  }

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

  const onCardContextMenu = (event: React.MouseEvent, config: ConnectionConfig): void => {
    event.preventDefault()
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
      { separator: true },
      { label: 'Delete Connection…', onSelect: () => setConfirmDelete(config) }
    ])
  }

  return (
    <div className="home">
      <div className="home-head">
        <h1>MySQL Connections</h1>
        <button
          className="icon-btn"
          title="Add new connection"
          onClick={() => setCreating(true)}
          style={{ width: 22, height: 22 }}
        >
          <PlusIcon size={16} />
        </button>
        <button
          className="btn"
          style={{
            minWidth: 0,
            height: 24,
            padding: '0 10px',
            marginLeft: 8,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5
          }}
          title="Export all connections to a JSON file (passwords are not included)"
          onClick={() => void exportConnections()}
        >
          <ExportIcon size={13} /> Export
        </button>
        <button
          className="btn"
          style={{
            minWidth: 0,
            height: 24,
            padding: '0 10px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5
          }}
          title="Import connections from a JSON file"
          onClick={() => void importConnections()}
        >
          <ImportIcon size={13} /> Import
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

      {connections.length === 0 ? (
        <div className="home-empty">
          No connections yet.
          <br />
          Click the <strong>+</strong> above to add one.
        </div>
      ) : filtered.length === 0 ? (
        <div className="home-empty">No connections match “{filter}”.</div>
      ) : (
        <div className="conn-grid">
          {filtered.map((config) => {
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
            return (
              <div
                key={config.id}
                className={`conn-card${colored ? ' colored' : ''}${badge ? ' has-badge' : ''}`}
                style={cardStyle}
                onDoubleClick={() => void openConnection(config, true)}
                onContextMenu={(e) => onCardContextMenu(e, config)}
                title="Double-click to open · right-click for more"
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
          })}
        </div>
      )}

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
    </div>
  )
}
