import { useState } from 'react'
import { PASSPHRASE_RULES, isPassphraseValid } from '@shared/passphrase'
import { Modal } from './ui/Modal'

/**
 * Asks whether an export should carry its passwords, and if so under which
 * passphrase. The passphrase is the only protection on the resulting file, so
 * the rules are enforced here rather than merely suggested.
 */
export function ExportOptionsDialog({
  connectionCount,
  onCancel,
  onExport
}: {
  connectionCount: number
  onCancel(): void
  onExport(passphrase?: string): void
}): JSX.Element {
  const [include, setInclude] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [reveal, setReveal] = useState(false)

  const strong = isPassphraseValid(passphrase)
  const mismatch = confirm !== '' && confirm !== passphrase
  const ready = !include || (strong && confirm === passphrase)

  const submit = (): void => {
    if (!ready) return
    onExport(include ? passphrase : undefined)
  }

  return (
    <Modal
      title="Export connections"
      width={520}
      onClose={onCancel}
      onSubmit={submit}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={!ready}>
            Export
          </button>
        </>
      }
    >
      <p style={{ margin: '0 0 12px' }}>
        {connectionCount === 1
          ? 'Exporting 1 connection and its group.'
          : `Exporting ${connectionCount} connections and their groups.`}
      </p>

      <label className="checkline" style={{ marginBottom: 6 }}>
        <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} />
        Include passwords, encrypted with a passphrase
      </label>
      <p className="hint" style={{ margin: '0 0 14px' }}>
        Passwords are stored encrypted for this Windows account on this machine, so they cannot be
        carried to another computer as they are. Ticking this re-encrypts them with a passphrase you
        choose, which you will be asked for on import.
      </p>

      {include && (
        <>
          <div className="form-grid">
            <label>Passphrase:</label>
            <input
              className={`field${passphrase !== '' && !strong ? ' invalid' : ''}`}
              type={reveal ? 'text' : 'password'}
              value={passphrase}
              autoFocus
              spellCheck={false}
              onChange={(e) => setPassphrase(e.target.value)}
            />
            <span />

            <label>Confirm:</label>
            <input
              className={`field${mismatch ? ' invalid' : ''}`}
              type={reveal ? 'text' : 'password'}
              value={confirm}
              spellCheck={false}
              onChange={(e) => setConfirm(e.target.value)}
            />
            <span className="hint" style={{ color: mismatch ? 'var(--error)' : undefined }}>
              {mismatch ? 'The two entries do not match.' : ''}
            </span>
          </div>

          <label className="checkline" style={{ margin: '8px 0 10px' }}>
            <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
            Show passphrase
          </label>

          <ul style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 11, lineHeight: 1.8 }}>
            {PASSPHRASE_RULES.map((rule) => {
              const met = rule.test(passphrase)
              return (
                <li
                  key={rule.label}
                  style={{ color: met ? 'var(--ok)' : 'var(--text-dim)', listStyle: 'none' }}
                >
                  {met ? '✓' : '○'} {rule.label}
                </li>
              )
            })}
          </ul>

          <p className="hint" style={{ margin: 0, color: 'var(--warn)' }}>
            There is no way to recover the passwords in this file if you forget the passphrase.
            Anyone who has both the file and the passphrase has every password in it.
          </p>
        </>
      )}
    </Modal>
  )
}

/**
 * Asks for the passphrase of an export that carries passwords. Stays open on a
 * wrong passphrase so it can simply be retyped — a failed attempt writes
 * nothing, so retrying is free.
 */
export function ImportPassphraseDialog({
  error,
  busy,
  onCancel,
  onSubmit,
  onSkip
}: {
  error: string | null
  busy: boolean
  onCancel(): void
  onSubmit(passphrase: string): void
  onSkip(): void
}): JSX.Element {
  const [passphrase, setPassphrase] = useState('')
  const [reveal, setReveal] = useState(false)

  const submit = (): void => {
    if (!busy && passphrase !== '') onSubmit(passphrase)
  }

  return (
    <Modal
      title="This export contains passwords"
      width={520}
      onClose={onCancel}
      onSubmit={submit}
      footer={
        <>
          <button className="btn" onClick={onSkip} disabled={busy}>
            Import without passwords
          </button>
          <div className="spacer" />
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy || passphrase === ''}>
            {busy ? 'Importing…' : 'Import'}
          </button>
        </>
      }
    >
      <p style={{ margin: '0 0 12px' }}>
        Enter the passphrase used when the file was exported.
      </p>

      <div className="form-grid">
        <label>Passphrase:</label>
        <input
          className={`field${error ? ' invalid' : ''}`}
          type={reveal ? 'text' : 'password'}
          value={passphrase}
          autoFocus
          spellCheck={false}
          disabled={busy}
          onChange={(e) => setPassphrase(e.target.value)}
        />
        <span />
      </div>

      <label className="checkline" style={{ margin: '8px 0 0' }}>
        <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
        Show passphrase
      </label>

      {error && (
        <p className="hint" style={{ margin: '10px 0 0', color: 'var(--error)' }}>
          {error}
        </p>
      )}
    </Modal>
  )
}
