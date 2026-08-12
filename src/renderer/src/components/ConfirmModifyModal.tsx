import { useEffect, useRef } from 'react'
import { useDialogDrag } from './ui/useDialogDrag'

interface Props {
  sql: string
  connectionName: string
  onCancel(): void
  onConfirm(): void
  confirmLabel?: string
  /** Overrides the heading for things that are not a query (a dump import). */
  title?: string
  /** Overrides the line above the preview. */
  message?: string
}

/**
 * Loud, deliberately alarming confirmation shown before a modifying statement
 * runs on a connection flagged "confirm on modifying query". Cancel is focused
 * so Enter is safe; the run button is the scary one.
 */
export function ConfirmModifyModal({
  sql,
  connectionName,
  onCancel,
  onConfirm,
  confirmLabel = 'Run modifying query',
  title,
  message
}: Props): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const drag = useDialogDrag()

  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  return (
    <div className="modal-backdrop danger-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        ref={drag.ref}
        className="modal danger-modal"
        style={{ width: 640, ...drag.style }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="danger-title drag-handle" {...drag.handleProps}>
          {title ?? `⚠ Modifying query on ${connectionName}`}
        </div>
        <div className="modal-body">
          <p style={{ margin: '0 0 8px', fontWeight: 600, color: '#8c1010' }}>
            {message ??
              'This will change data or schema on this connection. Read it carefully before running.'}
          </p>
          <div className="sql-preview danger-preview">{sql}</div>
        </div>
        <div className="modal-footer danger-footer">
          <div className="spacer" />
          <button ref={cancelRef} className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
