import { useEffect, useState } from 'react'

interface Props {
  label: string
  /** How long to wait before the panel appears. The backdrop blocks input at once. */
  delayMs?: number
}

/**
 * Blocks the UI while a write is in flight. The backdrop goes up immediately so
 * nothing can be clicked or typed into mid-statement, but the labelled panel is
 * held back: fast operations finish before it ever appears, so the user does not
 * see a dialog flash past.
 */
export function BusyOverlay({ label, delayMs = 500 }: Props): JSX.Element {
  const [showPanel, setShowPanel] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setShowPanel(true), delayMs)
    return () => window.clearTimeout(timer)
  }, [delayMs])

  // The backdrop stops the mouse, but focus stays wherever it was (usually the
  // editor), so keys have to be swallowed separately.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className="modal-backdrop busy-backdrop" onMouseDown={(e) => e.preventDefault()}>
      {showPanel && (
        <div className="busy-panel">
          <span className="busy-spinner" />
          {label}
        </div>
      )}
    </div>
  )
}
