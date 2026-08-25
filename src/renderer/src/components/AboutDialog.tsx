/**
 * About box: what this build is, for anyone filing a bug or checking whether
 * an update has landed. The runtime versions sit under the app's own because
 * they are the next thing a bug report needs.
 */

import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/types'
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

  useEffect(() => {
    let live = true
    void window.api.app.info().then((next) => {
      if (live) setInfo(next)
    })
    return () => {
      live = false
    }
  }, [])

  return (
    <Modal
      title="About MySQL Browser"
      width={380}
      onClose={onClose}
      onSubmit={onClose}
      footer={
        <>
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
      </div>
    </Modal>
  )
}
