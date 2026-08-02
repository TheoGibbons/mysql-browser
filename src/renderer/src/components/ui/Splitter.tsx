import { useCallback, useEffect, useRef, useState } from 'react'

interface SplitterProps {
  orientation: 'vertical' | 'horizontal'
  /** Current size of the pane being resized, in px. */
  size: number
  onResize(size: number): void
  onCommit?(size: number): void
  min?: number
  max?: number
  /**
   * Which side of the splitter the resized pane sits on. `before` means
   * dragging right/down grows it; `after` means dragging left/up grows it.
   */
  grow: 'before' | 'after'
}

export function Splitter({
  orientation,
  size,
  onResize,
  onCommit,
  min = 80,
  max = 4000,
  grow
}: SplitterProps): JSX.Element {
  const [dragging, setDragging] = useState(false)
  const startRef = useRef({ pointer: 0, size: 0 })

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      startRef.current = {
        pointer: orientation === 'vertical' ? e.clientX : e.clientY,
        size
      }
      setDragging(true)
    },
    [orientation, size]
  )

  useEffect(() => {
    if (!dragging) return

    const move = (e: PointerEvent): void => {
      const pointer = orientation === 'vertical' ? e.clientX : e.clientY
      const delta = pointer - startRef.current.pointer
      const signed = grow === 'before' ? delta : -delta
      const next = Math.min(max, Math.max(min, Math.round(startRef.current.size + signed)))
      onResize(next)
    }

    const up = (): void => {
      setDragging(false)
      onCommit?.(size)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    // A drag over the editor would otherwise start a text selection.
    document.body.style.userSelect = 'none'
    document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize'

    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [dragging, orientation, grow, min, max, onResize, onCommit, size])

  return (
    <div
      className={`${orientation === 'vertical' ? 'splitter-v' : 'splitter-h'}${dragging ? ' dragging' : ''}`}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation={orientation}
    />
  )
}
