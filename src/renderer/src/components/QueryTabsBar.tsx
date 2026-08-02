import { useEffect, useRef } from 'react'
import type { QueryTabState } from '@shared/types'
import { useContextMenu } from './ui/ContextMenu'

interface Props {
  tabs: QueryTabState[]
  activeTabId: string | null
  running: Record<string, boolean>
  onSelect(tabId: string): void
  onClose(tabId: string): void
  onCloseMany(tabIds: string[]): void
  onNewTab(): void
}

const KIND_PREFIX: Record<QueryTabState['kind'], string> = {
  query: '',
  designer: '⚙ ',
  export: '⭱ ',
  import: '⭳ '
}

export function QueryTabsBar({
  tabs,
  activeTabId,
  running,
  onSelect,
  onClose,
  onCloseMany,
  onNewTab
}: Props): JSX.Element {
  const menu = useContextMenu()
  const barRef = useRef<HTMLDivElement>(null)

  // Keep the active tab in view when it changes from outside (e.g. Ctrl+T).
  useEffect(() => {
    const el = barRef.current?.querySelector<HTMLElement>('.query-tab.active')
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId])

  const openContextMenu = (event: React.MouseEvent, tabId: string): void => {
    event.preventDefault()
    const index = tabs.findIndex((t) => t.id === tabId)
    const toTheRight = tabs.slice(index + 1).map((t) => t.id)
    const others = tabs.filter((t) => t.id !== tabId).map((t) => t.id)

    menu.show(event, [
      { label: 'Close', onSelect: () => onClose(tabId) },
      { label: 'Close All', onSelect: () => onCloseMany(tabs.map((t) => t.id)) },
      { label: 'Close Others', onSelect: () => onCloseMany(others), disabled: others.length === 0 },
      {
        label: 'Close to the Right',
        onSelect: () => onCloseMany(toTheRight),
        disabled: toTheRight.length === 0
      }
    ])
  }

  return (
    <div className="query-tabbar" ref={barRef}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`query-tab${tab.id === activeTabId ? ' active' : ''}`}
          onMouseDown={(e) => {
            // Middle-click closes, matching browser and Workbench behaviour.
            if (e.button === 1) {
              e.preventDefault()
              onClose(tab.id)
              return
            }
            if (e.button === 0) onSelect(tab.id)
          }}
          onContextMenu={(e) => openContextMenu(e, tab.id)}
          title={tab.title}
        >
          {running[tab.id] && <span className="running-dot" />}
          <span className="label">
            {KIND_PREFIX[tab.kind]}
            {tab.title}
          </span>
          <span
            className="tab-close"
            title="Close tab"
            onMouseDown={(e) => {
              e.stopPropagation()
              e.preventDefault()
            }}
            onClick={(e) => {
              e.stopPropagation()
              onClose(tab.id)
            }}
          >
            ×
          </span>
        </div>
      ))}
      <div
        className="query-tab"
        style={{ padding: '0 10px', color: 'var(--text-dim)' }}
        title="New query tab (Ctrl+T)"
        onClick={onNewTab}
      >
        +
      </div>
    </div>
  )
}
