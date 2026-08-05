import { useEffect, useRef, useState } from 'react'
import type { ConnectionConfig, ConnectionMethod, DbEngine } from '@shared/types'
import { DEFAULT_PORTS, engineOf } from '@shared/types'
import { Modal } from './ui/Modal'
import { ColorField } from './ui/ColorField'
import { newId } from '../lib/ids'

const METHOD_LABELS: Record<ConnectionMethod, string> = {
  tcp: 'Standard (TCP/IP)',
  ssh: 'Standard (TCP/IP) over SSH',
  iam: 'Standard (TCP/IP) AWS IAM'
}

const ENGINE_LABELS: Record<DbEngine, string> = {
  mysql: 'MySQL / MariaDB',
  postgres: 'PostgreSQL'
}

/** Sensible default user for a fresh connection to each server. */
const DEFAULT_USERS: Record<DbEngine, string> = {
  mysql: 'root',
  postgres: 'postgres'
}

function blankConnection(): ConnectionConfig {
  return {
    id: '',
    name: '',
    method: 'tcp',
    engine: 'mysql',
    host: '127.0.0.1',
    port: DEFAULT_PORTS.mysql,
    user: DEFAULT_USERS.mysql,
    password: '',
    database: '',
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
  const [testResult, setTestResult] = useState<{
    tone: 'ok' | 'error' | 'info'
    message: string
  } | null>(null)
  const [saving, setSaving] = useState(false)
  /** Token of the test in flight, so a second click (or closing) can stop it. */
  const testIdRef = useRef<string | null>(null)
  const stoppingRef = useRef(false)

  // A test left running would hold a worker — and its socket — open for as long
  // as the connect attempt takes to time out.
  useEffect(
    () => () => {
      if (testIdRef.current) void window.api.connections.testCancel(testIdRef.current)
    },
    []
  )

  const engine = engineOf(config)
  const isPostgres = engine === 'postgres'
  const serverName = isPostgres ? 'PostgreSQL' : 'MySQL'

  const patch = (next: Partial<ConnectionConfig>): void => {
    setConfig((current) => ({ ...current, ...next }))
    setTestResult(null)
  }

  /**
   * Switching engine carries over anything the user typed, but the port and
   * username defaults only make sense per engine — so those move with it,
   * unless they have been changed from the default already.
   */
  const switchEngine = (next: DbEngine): void => {
    const previous = engineOf(config)
    if (next === previous) return
    patch({
      engine: next,
      port: config.port === DEFAULT_PORTS[previous] ? DEFAULT_PORTS[next] : config.port,
      user: config.user === DEFAULT_USERS[previous] ? DEFAULT_USERS[next] : config.user
    })
  }

  const nameInvalid = config.name.trim() === ''
  // Postgres binds a connection to one database and cannot cross to another.
  const databaseInvalid = isPostgres && (config.database ?? '').trim() === ''

  /** Fills in the fields the save/test paths both need to normalise. */
  const normalised = (id: string): ConnectionConfig => ({
    ...config,
    id,
    engine,
    port: Number(config.port) || DEFAULT_PORTS[engine],
    sshPort: Number(config.sshPort) || 22
  })

  const save = async (): Promise<void> => {
    if (nameInvalid || databaseInvalid || saving) return
    setSaving(true)
    try {
      const toSave: ConnectionConfig = {
        ...normalised(config.id || newId('conn')),
        name: config.name.trim()
      }
      onSaved(await window.api.connections.save(toSave))
    } catch (err) {
      setTestResult({ tone: 'error', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  /** Starts a test, or — clicked while one is running — stops it. */
  const test = async (): Promise<void> => {
    if (testing) {
      if (!testIdRef.current) return
      stoppingRef.current = true
      void window.api.connections.testCancel(testIdRef.current)
      return
    }

    const testId = newId('test')
    testIdRef.current = testId
    stoppingRef.current = false
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.api.connections.test(normalised(config.id || 'test'), testId)
      setTestResult({
        tone: 'ok',
        message: `Connected to ${serverName} ${result.serverVersion} in ${result.latencyMs} ms.`
      })
    } catch (err) {
      setTestResult({
        tone: stoppingRef.current ? 'info' : 'error',
        message: (err as Error).message
      })
    } finally {
      testIdRef.current = null
      stoppingRef.current = false
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
          <button
            className="btn"
            style={{ minWidth: 120 }}
            onClick={test}
            title={testing ? 'Stop the connection test' : undefined}
          >
            {testing ? 'Stop Test' : 'Test Connection'}
          </button>
          {testing ? (
            <span className="hint">Testing…</span>
          ) : (
            testResult && (
              <span
                className="hint"
                style={{
                  color:
                    testResult.tone === 'ok'
                      ? 'var(--ok)'
                      : testResult.tone === 'error'
                        ? 'var(--error)'
                        : undefined,
                  maxWidth: 320,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
                title={testResult.message}
              >
                {testResult.message}
              </span>
            )
          )}
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={save}
            disabled={nameInvalid || databaseInvalid || saving}
          >
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

        <label>Database Server:</label>
        <select
          className="field"
          value={engine}
          onChange={(e) => switchEngine(e.target.value as DbEngine)}
        >
          {(Object.keys(ENGINE_LABELS) as DbEngine[]).map((value) => (
            <option key={value} value={value}>
              {ENGINE_LABELS[value]}
            </option>
          ))}
        </select>
        <span className="hint">
          Which server this connection talks to. Changing it also moves the default port and
          username.
        </span>

        <label>Connection Method:</label>
        <select
          className="field"
          value={config.method}
          onChange={(e) => {
            const method = e.target.value as ConnectionMethod
            // AWS only accepts an IAM token over TLS, and the RDS CA is not one
            // Node trusts out of the box.
            patch(
              method === 'iam'
                ? { method, useSSL: true, rejectUnauthorized: false }
                : { method }
            )
          }}
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
                  title={config.sshHost || undefined}
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

              <label>{serverName} Hostname:</label>
              <input
                className="field"
                value={config.host}
                title={config.host || undefined}
                onChange={(e) => patch({ host: e.target.value })}
              />
              <span className="hint">{serverName} server host relative to the SSH server.</span>

              <label>{serverName} Server Port:</label>
              <input
                className="field"
                value={config.port}
                onChange={(e) => patch({ port: Number(e.target.value) || 0 })}
              />
              <span className="hint">TCP/IP port of the {serverName} server.</span>
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
                  title={config.host || undefined}
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
                query tab opens its connection. It uses whatever AWS credentials the command
                itself finds - add --profile if the default one is not the right identity.
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

          {isPostgres && (
            <>
              <label>Database:</label>
              <input
                className={`field${databaseInvalid ? ' invalid' : ''}`}
                placeholder="postgres"
                value={config.database ?? ''}
                onChange={(e) => patch({ database: e.target.value })}
              />
              <span className="hint">
                PostgreSQL binds a connection to one database and cannot reach another without
                reconnecting, so this is required. The tree then lists that database&apos;s schemas.
              </span>
            </>
          )}

          <label>Default Schema:</label>
          <input
            className="field"
            placeholder={isPostgres ? 'public' : undefined}
            value={config.defaultSchema ?? ''}
            onChange={(e) => patch({ defaultSchema: e.target.value })}
          />
          <span className="hint">
            {isPostgres
              ? 'Schema to put first on the search_path, so unqualified names resolve there. (Optional)'
              : 'The schema to use as default schema. (Optional)'}
          </span>

          <label>Use SSL:</label>
          <div className="row" style={{ gap: 14 }}>
            <label className="checkline" style={{ opacity: config.method === 'iam' ? 0.45 : 1 }}>
              <input
                type="checkbox"
                disabled={config.method === 'iam'}
                checked={config.method === 'iam' || (config.useSSL ?? false)}
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
          <span className="hint">
            {config.method === 'iam'
              ? 'Always on for AWS IAM - the token is only accepted over TLS. Leave verification off unless you have added the Amazon RDS CA to your machine.'
              : `Required by most managed ${serverName} services.`}
          </span>
        </div>
      </fieldset>

      <fieldset className="group" style={{ marginBottom: 0 }}>
        <legend>Appearance & Safety</legend>
        <div className="prefs-grid">
          <label>Colour:</label>
          <ColorField value={config.color ?? ''} onChange={(color) => patch({ color })} />
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
