/**
 * A quiet corner chip for background updates.
 *
 * Updates install themselves when the app next closes, so this never demands
 * attention — it reports progress, and offers an early restart for anyone who
 * wants the new version straight away. Restarting with queries in flight asks
 * for confirmation first, since it drops every open connection.
 */

import { useEffect, useState } from 'react'
import type { UpdateState } from '@shared/types'
import { useAppStore } from '../store'

export function UpdateChip(): JSX.Element | null {
  const [state, setState] = useState<UpdateState>({ phase: 'idle' })
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const connTabs = useAppStore((s) => s.connTabs)

  useEffect(() => {
    void window.api.updates.get().then(setState)
    return window.api.updates.onState(setState)
  }, [])

  const busyCount = connTabs.reduce(
    (n, tab) => n + Object.values(tab.running).filter(Boolean).length,
    0
  )

  if (state.phase === 'downloading') {
    return (
      <div className="update-chip">
        <span className="update-chip-label">
          Downloading {state.version} — {state.percent}%
        </span>
      </div>
    )
  }

  if (state.phase !== 'ready' || dismissed === state.version) return null

  return (
    <div className="update-chip ready">
      {confirming ? (
        <>
          <span className="update-chip-label">
            {busyCount === 1 ? '1 query is' : `${busyCount} queries are`} still running. Restart
            anyway?
          </span>
          <button className="update-chip-action" onClick={() => void window.api.updates.install()}>
            Restart anyway
          </button>
          <button className="update-chip-action" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <span className="update-chip-label">
            Version {state.version} is ready — it installs when you close the app.
          </span>
          <button
            className="update-chip-action"
            onClick={() => {
              if (busyCount > 0) setConfirming(true)
              else void window.api.updates.install()
            }}
          >
            Restart now
          </button>
          <button
            className="update-chip-close"
            title="Dismiss"
            onClick={() => setDismissed(state.version)}
          >
            ×
          </button>
        </>
      )}
    </div>
  )
}
