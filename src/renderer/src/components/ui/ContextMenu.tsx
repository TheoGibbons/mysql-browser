import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export interface MenuItem {
  label: string
  onSelect?: () => void
  disabled?: boolean
  submenu?: MenuEntry[]
  separator?: false
}

export interface MenuSeparator {
  separator: true
}

export type MenuEntry = MenuItem | MenuSeparator

const isSeparator = (entry: MenuEntry): entry is MenuSeparator =>
  'separator' in entry && entry.separator === true

interface MenuContextValue {
  show(event: { clientX: number; clientY: number }, entries: MenuEntry[]): void
  close(): void
}

const MenuContext = createContext<MenuContextValue | null>(null)

export function useContextMenu(): MenuContextValue {
  const ctx = useContext(MenuContext)
  if (!ctx) throw new Error('useContextMenu must be used inside <ContextMenuProvider>')
  return ctx
}

interface OpenMenu {
  x: number
  y: number
  entries: MenuEntry[]
}

export function ContextMenuProvider({ children }: { children: ReactNode }): JSX.Element {
  const [menu, setMenu] = useState<OpenMenu | null>(null)

  const show = useCallback((event: { clientX: number; clientY: number }, entries: MenuEntry[]) => {
    setMenu({ x: event.clientX, y: event.clientY, entries })
  }, [])

  const close = useCallback(() => setMenu(null), [])

  useEffect(() => {
    if (!menu) return
    // A mousedown inside the menu must NOT close it here: the capture-phase
    // listener runs before the item's own onClick, so dismissing on it would
    // unmount the item before the click lands and the action would be lost.
    // Clicks inside the menu are handled by each item (select + close).
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && target.closest('.context-menu')) return
      close()
    }
    const dismiss = (): void => close()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    // `capture` so a click outside closes before the target handles it.
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu, close])

  return (
    <MenuContext.Provider value={{ show, close }}>
      {children}
      {menu && <MenuPanel x={menu.x} y={menu.y} entries={menu.entries} onClose={close} />}
    </MenuContext.Provider>
  )
}

interface PanelProps {
  x: number
  y: number
  entries: MenuEntry[]
  onClose(): void
  /** Submenus open to the side of their parent instead of at the cursor. */
  nested?: boolean
}

function MenuPanel({ x, y, entries, onClose }: PanelProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y })
  const [openSub, setOpenSub] = useState<{ index: number; x: number; y: number } | null>(null)

  // Flip the menu back on-screen when it would overflow the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let nextX = x
    let nextY = y
    if (x + rect.width > window.innerWidth) nextX = Math.max(0, window.innerWidth - rect.width - 4)
    if (y + rect.height > window.innerHeight) nextY = Math.max(0, window.innerHeight - rect.height - 4)
    setPosition({ x: nextX, y: nextY })
  }, [x, y, entries])

  return (
    <>
      <div
        ref={ref}
        className="context-menu"
        style={{ left: position.x, top: position.y }}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {entries.map((entry, index) =>
          isSeparator(entry) ? (
            <div key={index} className="context-sep" />
          ) : (
            <div
              key={index}
              className={`context-item${entry.disabled ? ' disabled' : ''}`}
              onMouseEnter={(e) => {
                if (entry.submenu && !entry.disabled) {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setOpenSub({ index, x: rect.right - 2, y: rect.top - 4 })
                } else {
                  setOpenSub(null)
                }
              }}
              onClick={() => {
                if (entry.disabled || entry.submenu) return
                // Dismiss first. If the action throws, the menu still closes and
                // the error reaches the console, instead of the click looking
                // like it never landed at all.
                onClose()
                entry.onSelect?.()
              }}
            >
              <span>{entry.label}</span>
              {entry.submenu && <span className="submenu-arrow">▶</span>}
            </div>
          )
        )}
      </div>
      {openSub &&
        (() => {
          const entry = entries[openSub.index]
          if (isSeparator(entry) || !entry.submenu) return null
          return (
            <MenuPanel
              x={openSub.x}
              y={openSub.y}
              entries={entry.submenu}
              onClose={onClose}
              nested
            />
          )
        })()}
    </>
  )
}
