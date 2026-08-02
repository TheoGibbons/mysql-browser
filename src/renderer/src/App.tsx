import { useEffect } from 'react'
import { useAppStore } from './store'
import { ContextMenuProvider, useContextMenu } from './components/ui/ContextMenu'
import { HomePage } from './components/HomePage'
import { ConnectionView } from './components/ConnectionView'
import { HomeIcon } from './components/ui/Icons'

function Shell(): JSX.Element {
  const ready = useAppStore((s) => s.ready)
  const init = useAppStore((s) => s.init)
  const connTabs = useAppStore((s) => s.connTabs)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const setActiveSession = useAppStore((s) => s.setActiveSession)
  const closeConnTab = useAppStore((s) => s.closeConnTab)
  const flushAutosave = useAppStore((s) => s.flushAutosave)
  const autoSaveIntervalSec = useAppStore((s) => s.prefs.autoSaveIntervalSec)
  const menu = useContextMenu()

  useEffect(() => {
    void init()
  }, [init])

  // Autosave loop. Interval 0 means "only save on close".
  useEffect(() => {
    if (autoSaveIntervalSec <= 0) return
    const timer = window.setInterval(
      () => void flushAutosave(),
      Math.max(2, autoSaveIntervalSec) * 1000
    )
    return () => window.clearInterval(timer)
  }, [autoSaveIntervalSec, flushAutosave])

  // Last-chance save when the window goes away.
  useEffect(() => {
    const onUnload = (): void => {
      void flushAutosave()
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [flushAutosave])

  const active = connTabs.find((t) => t.sessionId === activeSessionId) ?? null

  if (!ready) {
    return <div className="placeholder-tab">Loading…</div>
  }

  return (
    <div className="app">
      <div className="conn-tabbar">
        <div
          className={`conn-tab home-tab${activeSessionId === null ? ' active' : ''}`}
          onClick={() => setActiveSession(null)}
          title="Connections"
        >
          <HomeIcon />
        </div>

        {connTabs.map((tab) => (
          <div
            key={tab.sessionId}
            className={`conn-tab${tab.sessionId === activeSessionId ? ' active' : ''}`}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                void closeConnTab(tab.sessionId)
                return
              }
              if (e.button === 0) setActiveSession(tab.sessionId)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              menu.show(e, [
                { label: 'Close', onSelect: () => void closeConnTab(tab.sessionId) },
                {
                  label: 'Close Others',
                  onSelect: () => {
                    for (const other of connTabs) {
                      if (other.sessionId !== tab.sessionId) void closeConnTab(other.sessionId)
                    }
                  },
                  disabled: connTabs.length < 2
                },
                { separator: true },
                {
                  label: 'Reconnect',
                  onSelect: () => void useAppStore.getState().reconnect(tab.sessionId)
                }
              ])
            }}
            title={`${tab.name} — ${tab.config.host}:${tab.config.port}`}
          >
            <span className={`status-dot ${tab.status}`} />
            <span className="label">{tab.name}</span>
            <span
              className="tab-close"
              onMouseDown={(e) => {
                e.stopPropagation()
                e.preventDefault()
              }}
              onClick={(e) => {
                e.stopPropagation()
                void closeConnTab(tab.sessionId)
              }}
            >
              ×
            </span>
          </div>
        ))}
      </div>

      {active ? <ConnectionView key={active.sessionId} conn={active} /> : <HomePage />}
    </div>
  )
}

export function App(): JSX.Element {
  return (
    <ContextMenuProvider>
      <Shell />
    </ContextMenuProvider>
  )
}
