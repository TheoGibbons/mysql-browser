/**
 * About box: what this build is, for anyone filing a bug or checking whether
 * an update has landed. The runtime versions sit under the app's own because
 * they are the next thing a bug report needs.
 */

import { useEffect, useState } from 'react'
import type { AppInfo, UpdateState } from '@shared/types'
import { Modal } from './ui/Modal'

/** The app icon, inlined so the dialog doesn't depend on a packaged asset. */
function AppMark({ size = 56 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden="true">
      <defs>
        <linearGradient id="about-tile" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4b8fe6" />
          <stop offset="1" stopColor="#1d5099" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="256" height="256" rx="52" fill="url(#about-tile)" />
      <g fill="none" stroke="#ffffff" strokeWidth="13" strokeLinecap="round">
        <path d="M70 78 L70 178" />
        <path d="M186 78 L186 178" />
        <path d="M70 178 A58 22 0 0 0 186 178" />
        <path d="M70 125 A58 22 0 0 0 186 125" />
      </g>
      <ellipse cx="128" cy="78" rx="64" ry="22" fill="#ffffff" />
    </svg>
  )
}

export function AboutDialog({ onClose }: { onClose(): void }): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)
  const [hasChecked, setHasChecked] = useState(false)

  useEffect(() => {
    let live = true
    void window.api.app.info().then((next) => {
      if (live) setInfo(next)
    })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    let live = true
    const unsubscribe = window.api.updates.onState(setUpdateState)
    void window.api.updates.get()
      .then((next) => {
        // A live event or manual check may have already supplied a newer state.
        if (live) setUpdateState((current) => current ?? next)
      })
      .catch((err: unknown) => {
        if (live) {
          setUpdateState((current) => current ?? {
            phase: 'error',
            message: err instanceof Error ? err.message : String(err)
          })
        }
      })
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  const checkForUpdates = async (): Promise<void> => {
    setChecking(true)
    setHasChecked(true)
    setUpdateState({ phase: 'checking' })
    try {
      setUpdateState(await window.api.updates.check())
    } catch (err) {
      setUpdateState({
        phase: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setChecking(false)
    }
  }

  const isChecking = checking || updateState?.phase === 'checking'

  return (
    <Modal
      title="About MySQL Browser"
      width={380}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn"
            onClick={() => void checkForUpdates()}
            disabled={
              !updateState ||
              isChecking ||
              updateState.phase === 'downloading' ||
              updateState.phase === 'ready'
            }
          >
            {isChecking ? 'Checking…' : 'Check for new version'}
          </button>
          <div className="spacer" />
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="about">
        <AppMark />
        <div className="about-name">MySQL Browser</div>
        {/* The line keeps its height while loading, so nothing jumps. */}
        <div className="about-version">{info && `Version ${info.version}`}</div>
        {info && (
          <div className="about-runtime">
            Electron {info.electron} · Chromium {info.chrome} · Node {info.node}
          </div>
        )}
        <div
          className="about-update-status"
          role="status"
          style={{ color: updateState?.phase === 'error' ? 'var(--error)' : undefined }}
        >
          {isChecking && 'Checking for a new version…'}
          {!isChecking && updateState?.phase === 'idle' && hasChecked &&
            'You’re using the latest version.'}
          {!isChecking && updateState?.phase === 'downloading' &&
            `Downloading version ${updateState.version} — ${updateState.percent}%`}
          {!isChecking && updateState?.phase === 'ready' &&
            `Version ${updateState.version} is ready. It will install when you close the app.`}
          {!isChecking && updateState?.phase === 'error' &&
            `Could not check for updates: ${updateState.message}`}
        </div>
      </div>
    </Modal>
  )
}
