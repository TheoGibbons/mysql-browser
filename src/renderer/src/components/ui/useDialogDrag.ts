import { useCallback, useEffect, useRef, useState } from 'react'

interface Point {
  x: number
  y: number
}

interface Box {
  /** Where the layout (before any drag transform) puts the dialog's top-left. */
  origin: Point
  width: number
  height: number
}

interface DialogDrag {
  /** Attach to the dialog box itself so its bounds can be measured. */
  ref: React.RefObject<HTMLDivElement | null>
  /** Merge into the dialog's style to apply the current offset. */
  style: { transform: string | undefined }
  /** Spread onto the title bar to make it the drag handle. */
  handleProps: {
    onPointerDown(e: React.PointerEvent): void
    onDoubleClick(): void
  }
  dragging: boolean
}

/**
 * `applied` is the offset the element is currently rendered with, so taking it
 * back out of the measured rect gives the untransformed layout position.
 */
function measure(el: HTMLElement, applied: Point): Box {
  const rect = el.getBoundingClientRect()
  return {
    origin: { x: rect.left - applied.x, y: rect.top - applied.y },
    width: rect.width,
    height: rect.height
  }
}

/** Keeps the dialog fully on screen. */
function clamp(offset: Point, box: Box): Point {
  // When the dialog is larger than the window, pin its top-left corner rather
  // than letting the max fall below the min.
  const maxX = Math.max(-box.origin.x, window.innerWidth - box.origin.x - box.width)
  const maxY = Math.max(-box.origin.y, window.innerHeight - box.origin.y - box.height)
  return {
    x: Math.min(Math.max(offset.x, -box.origin.x), maxX),
    y: Math.min(Math.max(offset.y, -box.origin.y), maxY)
  }
}

/**
 * Makes a centred dialog draggable by its title bar, within the window. The
 * dialog stays laid out where it was; only a transform moves it, so nothing
 * about its sizing or centring changes. Double-clicking the title bar recentres
 * it.
 */
export function useDialogDrag(): DialogDrag {
  const ref = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const startRef = useRef<{ pointer: Point; offset: Point; box: Box | null }>({
    pointer: { x: 0, y: 0 },
    offset: { x: 0, y: 0 },
    box: null
  })

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Right/middle clicks shouldn't start a drag.
      if (e.button !== 0) return
      e.preventDefault()
      startRef.current = {
        pointer: { x: e.clientX, y: e.clientY },
        offset,
        box: ref.current ? measure(ref.current, offset) : null
      }
      setDragging(true)
    },
    [offset]
  )

  useEffect(() => {
    if (!dragging) return

    const move = (e: PointerEvent): void => {
      const start = startRef.current
      const next = {
        x: start.offset.x + (e.clientX - start.pointer.x),
        y: start.offset.y + (e.clientY - start.pointer.y)
      }
      setOffset(start.box ? clamp(next, start.box) : next)
    }
    const up = (): void => setDragging(false)

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    // Otherwise the drag paints a text selection across the dialog.
    document.body.style.userSelect = 'none'

    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
    }
  }, [dragging])

  // A shrinking window (or a dialog that grew) could otherwise strand a moved
  // dialog off screen.
  useEffect(() => {
    const onResize = (): void => {
      setOffset((current) =>
        ref.current ? clamp(current, measure(ref.current, current)) : current
      )
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return {
    ref,
    style: {
      transform: offset.x || offset.y ? `translate(${offset.x}px, ${offset.y}px)` : undefined
    },
    handleProps: { onPointerDown, onDoubleClick: () => setOffset({ x: 0, y: 0 }) },
    dragging
  }
}
