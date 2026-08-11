import { useState } from 'react'
import { Modal } from './ui/Modal'

interface Props {
  sql: string
  statementCount: number
  onCancel(): void
  onConfirm(): void
  error?: string | null
}

/**
 * Shown before writing grid edits back. The SQL is selectable and copyable so
 * the user can inspect exactly what will run.
 */
export function ApplyChangesModal({
  sql,
  statementCount,
  onCancel,
  onConfirm,
  error
}: Props): JSX.Element {
  const [copied, setCopied] = useState(false)

  const copy = async (): Promise<void> => {
    await window.api.clipboard.write(sql)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Modal
      title="Apply changes to database"
      width={780}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" style={{ minWidth: 130 }} onClick={copy}>
            {copied ? 'Copied ✓' : 'Copy SQL'}
          </button>
          {error && (
            <span className="hint" style={{ color: 'var(--error)', flex: 1 }}>
              {error}
            </span>
          )}
          <div className="spacer" />
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={onConfirm}>
            OK
          </button>
        </>
      }
    >
      <p style={{ margin: '0 0 8px' }}>
        The following {statementCount} statement{statementCount === 1 ? '' : 's'} will be executed:
      </p>
      <div className="sql-preview">{sql}</div>
    </Modal>
  )
}
