import { useState } from 'react'
import { DEFAULT_PREFERENCES, type ConnectionConfig, type Preferences } from '@shared/types'
import { Modal } from './ui/Modal'
import { useAppStore } from '../store'

interface Props {
  /** When set, edits become overrides stored on that connection. */
  connection?: ConnectionConfig
  onClose(): void
}

interface NumberFieldProps {
  label: string
  value: number
  onChange(value: number): void
  hint?: string
  min?: number
  suffix?: string
}

function NumberField({ label, value, onChange, hint, min = 0, suffix }: NumberFieldProps): JSX.Element {
  return (
    <>
      <label>{label}</label>
      <div className="row" style={{ gap: 6 }}>
        <input
          className="field"
          style={{ width: 110 }}
          type="number"
          min={min}
          value={Number.isFinite(value) ? value : 0}
          onChange={(e) => onChange(Math.max(min, Number(e.target.value) || 0))}
        />
        {suffix && <span className="hint">{suffix}</span>}
      </div>
      {hint && <div className="prefs-hint">{hint}</div>}
    </>
  )
}

interface TextFieldProps {
  label: string
  value: string
  onChange(value: string): void
  hint?: string
  browse?: 'file' | 'directory'
}

function TextField({ label, value, onChange, hint, browse }: TextFieldProps): JSX.Element {
  const pick = async (): Promise<void> => {
    const result =
      browse === 'directory'
        ? await window.api.dialog.openDirectory(label)
        : await window.api.dialog.openFile(label, [
            { name: 'Executables', extensions: ['exe'] },
            { name: 'All files', extensions: ['*'] }
          ])
    if (result) onChange(result)
  }

  return (
    <>
      <label>{label}</label>
      <div className="row" style={{ gap: 6 }}>
        <input className="field" style={{ flex: 1 }} value={value} onChange={(e) => onChange(e.target.value)} />
        {browse && (
          <button className="btn" style={{ minWidth: 34, height: 22 }} onClick={pick}>
            …
          </button>
        )}
      </div>
      {hint && <div className="prefs-hint">{hint}</div>}
    </>
  )
}

export function PreferencesDialog({ connection, onClose }: Props): JSX.Element {
  const globalPrefs = useAppStore((s) => s.prefs)
  const savePrefs = useAppStore((s) => s.setPrefs)
  const setConnections = useAppStore((s) => s.setConnections)

  const [prefs, setPrefs] = useState<Preferences>(() => ({
    ...globalPrefs,
    ...(connection?.prefs ?? {})
  }))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const patch = (next: Partial<Preferences>): void => setPrefs((p) => ({ ...p, ...next }))

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      if (connection) {
        // Persist only the values that differ from global, so later global
        // changes still flow through.
        const overrides: Partial<Preferences> = {}
        for (const key of Object.keys(prefs) as (keyof Preferences)[]) {
          if (prefs[key] !== globalPrefs[key]) (overrides as any)[key] = prefs[key]
        }
        const next = await window.api.connections.save({ ...connection, prefs: overrides })
        setConnections(next)
      } else {
        await savePrefs(prefs)
      }
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={connection ? `Preferences — ${connection.name}` : 'Preferences'}
      width={700}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn"
            style={{ minWidth: 110 }}
            onClick={() => setPrefs({ ...DEFAULT_PREFERENCES })}
          >
            Reset defaults
          </button>
          {error && (
            <span className="hint" style={{ color: 'var(--error)' }}>
              {error}
            </span>
          )}
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={saving}>
            OK
          </button>
        </>
      }
    >
      {connection && (
        <div className="banner info" style={{ marginBottom: 10, borderRadius: 3 }}>
          These settings only apply to <strong>{connection.name}</strong>
        </div>
      )}

      <fieldset className="group">
        <legend>General</legend>
        <div className="prefs-grid">
          <NumberField
            label="Auto-save interval:"
            value={prefs.autoSaveIntervalSec}
            onChange={(v) => patch({ autoSaveIntervalSec: v })}
            suffix="seconds"
            hint="Seconds between tab auto-saves. Set to 0 to only save on close."
          />
          <NumberField
            label="Max tab size to save:"
            value={prefs.maxTabSizeToSave}
            onChange={(v) => patch({ maxTabSizeToSave: v })}
            suffix="characters"
            hint="Tabs larger than this are saved without their result grid."
          />
        </div>
      </fieldset>

      <fieldset className="group">
        <legend>Database Session</legend>
        <div className="prefs-grid">
          <NumberField
            label="DBMS connection keep-alive interval:"
            value={prefs.keepAliveIntervalSec}
            onChange={(v) => patch({ keepAliveIntervalSec: v })}
            suffix="seconds"
            hint="Time interval between sending keep-alive messages to DBMS. Set to 0 to not send keep-alive messages."
          />
          <NumberField
            label="DBMS connection read timeout interval:"
            value={prefs.readTimeoutSec}
            onChange={(v) => patch({ readTimeoutSec: v })}
            suffix="seconds"
            hint="The maximum amount of time the query can take to return data from the DBMS. Set 0 to skip the read timeout."
          />
          <NumberField
            label="DBMS connection timeout interval:"
            value={prefs.connectTimeoutSec}
            onChange={(v) => patch({ connectTimeoutSec: v })}
            suffix="seconds"
            hint="Maximum time to wait before a connection attempt is aborted."
          />
        </div>
      </fieldset>

      <fieldset className="group">
        <legend>Data export and import</legend>
        <div className="prefs-grid">
          <TextField
            label="Path to mysqldump tool:"
            value={prefs.mysqldumpPath}
            onChange={(v) => patch({ mysqldumpPath: v })}
            browse="file"
            hint="Used by Data Export."
          />
          <TextField
            label="Path to mysql tool:"
            value={prefs.mysqlPath}
            onChange={(v) => patch({ mysqlPath: v })}
            browse="file"
            hint="Used by Data Import."
          />
          <TextField
            label="Export directory path:"
            value={prefs.exportDirectory}
            onChange={(v) => patch({ exportDirectory: v })}
            browse="directory"
            hint="Default location for dump files and result-grid exports."
          />
        </div>
      </fieldset>

      <fieldset className="group" style={{ marginBottom: 0 }}>
        <legend>Migration</legend>
        <div className="prefs-grid">
          <NumberField
            label="Migration connection timeout:"
            value={prefs.migrationConnectionTimeoutSec}
            onChange={(v) => patch({ migrationConnectionTimeoutSec: v })}
            suffix="seconds"
            hint="Maximum time to wait when connecting during a migration."
          />
        </div>
      </fieldset>
    </Modal>
  )
}
