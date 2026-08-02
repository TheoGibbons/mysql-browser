import { useState } from 'react'
import type { ConnectionConfig, ConnectionMethod } from '@shared/types'
import { Modal } from './ui/Modal'
import { ColorPicker } from './ui/ColorPicker'
import { newId } from '../lib/ids'

const METHOD_LABELS: Record<ConnectionMethod, string> = {
  tcp: 'Standard (TCP/IP)',
  ssh: 'Standard (TCP/IP) over SSH',
  iam: 'Standard (TCP/IP) AWS IAM'
}

function blankConnection(): ConnectionConfig {
  return {
    id: '',
    name: '',
    method: 'tcp',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    defaultSchema: '',
    sshHost: '127.0.0.1',
    sshPort: 22,
    sshUser: '',
    sshPassword: '',
    sshKeyFile: '',
    iamTokenCommand: '',
    useSSL: false,
    rejectUnauthorized: true,
    color: '',
    confirmModifying: false,
    createdAt: Date.now()
  }
}

interface Props {
  initial?: ConnectionConfig
  onClose(): void
  onSaved(connections: ConnectionConfig[]): void
}

export function ConnectionDialog({ initial, onClose, onSaved }: Props): JSX.Element {
  const [config, setConfig] = useState<ConnectionConfig>(() => ({
    ...blankConnection(),
    ...(initial ?? {})
  }))
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const patch = (next: Partial<ConnectionConfig>): void => {
    setConfig((current) => ({ ...current, ...next }))
    setTestResult(null)
  }

  const nameInvalid = config.name.trim() === ''

  const save = async (): Promise<void> => {
    if (nameInvalid || saving) return
    setSaving(true)
    try {
      const toSave: ConnectionConfig = {
        ...config,
        id: config.id || newId('conn'),
        name: config.name.trim(),
        port: Number(config.port) || 3306,
        sshPort: Number(config.sshPort) || 22
      }
      onSaved(await window.api.connections.save(toSave))
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.api.connections.test({
        ...config,
        id: config.id || 'test',
        port: Number(config.port) || 3306,
        sshPort: Number(config.sshPort) || 22
      })
      setTestResult({
        ok: true,
        message: `Connected to MySQL ${result.serverVersion} in ${result.latencyMs} ms.`
      })
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message })
    } finally {
      setTesting(false)
    }
  }

  const browseKeyFile = async (): Promise<void> => {
    const file = await window.api.dialog.openFile('Select SSH private key', [
      { name: 'All files', extensions: ['*'] }
    ])
    if (file) patch({ sshKeyFile: file })
  }

  return (
    <Modal
      title={initial?.id ? 'Edit Connection' : 'Setup New Connection'}
      width={720}
      onClose={onClose}
      footer={
        <>
          <button className="btn" style={{ minWidth: 120 }} onClick={test} disabled={testing}>
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
          {testResult && (
            <span
              className="hint"
              style={{
                color: testResult.ok ? 'var(--ok)' : 'var(--error)',
                maxWidth: 320,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
              title={testResult.message}
            >
              {testResult.message}
            </span>
          )}
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={nameInvalid || saving}>
            OK
          </button>
        </>
      }
    >
      <div className="form-grid" style={{ marginBottom: 12 }}>
        <label>Connection Name:</label>
        <input
          className={`field${nameInvalid ? ' invalid' : ''}`}
          value={config.name}
          autoFocus
          onChange={(e) => patch({ name: e.target.value })}
        />
        <span className="hint">Type a name for the connection</span>

        <label>Connection Method:</label>
        <select
          className="field"
          value={config.method}
          onChange={(e) => patch({ method: e.target.value as ConnectionMethod })}
        >
          {(Object.keys(METHOD_LABELS) as ConnectionMethod[]).map((method) => (
            <option key={method} value={method}>
              {METHOD_LABELS[method]}
            </option>
          ))}
        </select>
        <span className="hint">Method to use to connect to the RDBMS</span>
      </div>

      <fieldset className="group">
        <legend>Parameters</legend>
        <div className="form-grid">
          {config.method === 'ssh' && (
            <>
              <label>SSH Hostname:</label>
              <div className="row" style={{ gap: 6 }}>
                <input
                  className="field"
                  style={{ flex: 1 }}
                  value={config.sshHost ?? ''}
                  onChange={(e) => patch({ sshHost: e.target.value })}
                />
                <label style={{ whiteSpace: 'nowrap' }}>Port:</label>
                <input
                  className="field"
                  style={{ width: 70 }}
                  value={config.sshPort ?? 22}
                  onChange={(e) => patch({ sshPort: Number(e.target.value) || 0 })}
                />
              </div>
              <span className="hint">SSH server hostname and port.</span>

              <label>SSH Username:</label>
              <input
                className="field"
                value={config.sshUser ?? ''}
                onChange={(e) => patch({ sshUser: e.target.value })}
              />
              <span className="hint">Name of the SSH user to connect with.</span>

              <label>SSH Password:</label>
              <input
                className="field"
                type="password"
                value={config.sshPassword ?? ''}
                onChange={(e) => patch({ sshPassword: e.target.value })}
              />
              <span className="hint">Stored encrypted. Leave blank when using a key file.</span>

              <label>SSH Key File:</label>
              <div className="row" style={{ gap: 6 }}>
                <input
                  className="field"
                  style={{ flex: 1 }}
                  value={config.sshKeyFile ?? ''}
                  onChange={(e) => patch({ sshKeyFile: e.target.value })}
                />
                <button className="btn" style={{ minWidth: 34, height: 22 }} onClick={browseKeyFile}>
                  …
                </button>
              </div>
              <span className="hint">Path to SSH private key file.</span>

              <label>Key Passphrase:</label>
              <input
                className="field"
                type="password"
                value={config.sshPassphrase ?? ''}
                onChange={(e) => patch({ sshPassphrase: e.target.value })}
              />
              <span className="hint">Only needed for an encrypted key file.</span>

              <label>MySQL Hostname:</label>
              <input
                className="field"
                value={config.host}
                onChange={(e) => patch({ host: e.target.value })}
              />
              <span className="hint">MySQL server host relative to the SSH server.</span>

              <label>MySQL Server Port:</label>
              <input
                className="field"
                value={config.port}
                onChange={(e) => patch({ port: Number(e.target.value) || 0 })}
              />
              <span className="hint">TCP/IP port of the MySQL server.</span>
            </>
          )}

          {config.method !== 'ssh' && (
            <>
              <label>Hostname:</label>
              <div className="row" style={{ gap: 6 }}>
                <input
                  className="field"
                  style={{ flex: 1 }}
                  value={config.host}
                  onChange={(e) => patch({ host: e.target.value })}
                />
                <label style={{ whiteSpace: 'nowrap' }}>Port:</label>
                <input
                  className="field"
                  style={{ width: 70 }}
                  value={config.port}
                  onChange={(e) => patch({ port: Number(e.target.value) || 0 })}
                />
              </div>
              <span className="hint">Name or IP address of the server host - and TCP/IP port.</span>
            </>
          )}

          <label>Username:</label>
          <input
            className="field"
            value={config.user}
            onChange={(e) => patch({ user: e.target.value })}
          />
          <span className="hint">Name of the user to connect with.</span>

          {config.method === 'iam' ? (
            <>
              <label style={{ alignSelf: 'start', paddingTop: 4 }}>Token Command:</label>
              <textarea
                className="field"
                rows={3}
                placeholder="aws rds generate-db-auth-token --hostname my-db.eu-west-1.rds.amazonaws.com --port 3306 --region eu-west-1 --username db_user"
                value={config.iamTokenCommand ?? ''}
                onChange={(e) => patch({ iamTokenCommand: e.target.value })}
              />
              <span className="hint">
                Command whose stdout is used as the password. AWS IAM tokens expire after 15
                minutes, so it is re-run in the background every 10 minutes and before each new
                query tab opens its connection.
              </span>
            </>
          ) : (
            <>
              <label>Password:</label>
              <input
                className="field"
                type="password"
                value={config.password ?? ''}
                onChange={(e) => patch({ password: e.target.value })}
              />
              <span className="hint">Stored encrypted with your Windows account.</span>
            </>
          )}

          <label>Default Schema:</label>
          <input
            className="field"
            value={config.defaultSchema ?? ''}
            onChange={(e) => patch({ defaultSchema: e.target.value })}
          />
          <span className="hint">
            The schema to use as default schema. Leave blank to select it later.
          </span>

          <label>Use SSL:</label>
          <div className="row" style={{ gap: 14 }}>
            <label className="checkline">
              <input
                type="checkbox"
                checked={config.useSSL ?? false}
                onChange={(e) => patch({ useSSL: e.target.checked })}
              />
              Enable SSL/TLS
            </label>
            <label className="checkline" style={{ opacity: config.useSSL ? 1 : 0.45 }}>
              <input
                type="checkbox"
                disabled={!config.useSSL}
                checked={config.rejectUnauthorized !== false}
                onChange={(e) => patch({ rejectUnauthorized: e.target.checked })}
              />
              Verify server certificate
            </label>
          </div>
          <span className="hint">Required by most managed MySQL services.</span>
        </div>
      </fieldset>

      <fieldset className="group" style={{ marginBottom: 0 }}>
        <legend>Appearance & Safety</legend>
        <div className="prefs-grid">
          <label style={{ alignSelf: 'start', paddingTop: 2 }}>Colour:</label>
          <ColorPicker value={config.color ?? ''} onChange={(color) => patch({ color })} />
          <div className="prefs-hint">
            Tints the home card, the connection tab and the query editor. Use red for production so a
            live connection is obvious at a glance.
          </div>

          <label>Safety:</label>
          <label className="checkline">
            <input
              type="checkbox"
              checked={config.confirmModifying ?? false}
              onChange={(e) => patch({ confirmModifying: e.target.checked })}
            />
            Confirm on modifying query (tick on production databases)
          </label>
          <div className="prefs-hint">
            When ticked, an extra confirmation appears before any INSERT / UPDATE / DELETE / DDL
            statement run from the editor executes.
          </div>
        </div>
      </fieldset>
    </Modal>
  )
}
