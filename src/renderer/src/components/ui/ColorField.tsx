import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ColorPicker } from './ColorPicker'
import { isValidHex } from '../../lib/color'

interface Props {
  value: string
  onChange(hex: string): void
}

const POPOVER_WIDTH = 244
const POPOVER_HEIGHT = 260

/**
 * Compact colour control: a swatch + hex button that opens the full-range
 * picker in a popover, so the picker no longer eats half the dialog. The
 * popover is portaled to <body> so the dialog's scroll container can't clip it.
 */
export function ColorField({ value, onChange }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const hasColor = isValidHex(value)

  // Position the popover under the trigger, flipping/clamping to stay on-screen.
  useLayoutEffect(() => {
    if (!open) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    let left = rect.left
    let top = rect.bottom + 4
    if (left + POPOVER_WIDTH > window.innerWidth - 6) {
      left = Math.max(6, window.innerWidth - POPOVER_WIDTH - 6)
    }
    if (top + POPOVER_HEIGHT > window.innerHeight - 6) {
      top = Math.max(6, rect.top - POPOVER_HEIGHT - 4)
    }
    setPos({ left, top })
  }, [open])

  useEffect(() => {
    if (!open) return

    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.closest('.color-popover') || target.closest('.color-trigger'))) return
      setOpen(false)
    }
    // Capture so the popover's Escape closes only the popover, not the dialog.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        e.preventDefault()
        setOpen(false)
      }
    }
    const reposition = (): void => setOpen(false)

    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="color-trigger"
        onClick={() => setOpen((o) => !o)}
        title="Choose a colour"
      >
        <span
          className="color-trigger-swatch"
          style={{ background: hasColor ? value : undefined }}
          data-none={!hasColor}
        />
        <span className="color-trigger-label">{hasColor ? value.toLowerCase() : 'No colour'}</span>
        <span className="color-trigger-caret">▾</span>
      </button>

      {open &&
        createPortal(
          <div
            ref={popRef}
            className="color-popover"
            style={{ left: pos.left, top: pos.top, width: POPOVER_WIDTH }}
            // Keep dialog-level key handling (Enter/Escape) out of the popover.
            onKeyDown={(e) => e.stopPropagation()}
          >
            <ColorPicker value={value} onChange={onChange} />
          </div>,
          document.body
        )}
    </>
  )
}
