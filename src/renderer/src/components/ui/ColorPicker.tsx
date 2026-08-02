import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CONNECTION_COLORS,
  hexToHsv,
  hsvToHex,
  isValidHex,
  normalizeHex,
  readableTextColor,
  type Hsv
} from '../../lib/color'

interface Props {
  /** Current hex, or '' for no colour. */
  value: string
  onChange(hex: string): void
}

const SV_WIDTH = 220
const SV_HEIGHT = 130
const HUE_HEIGHT = 14

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

/**
 * Self-contained full-range HSV colour picker: a saturation/value square, a hue
 * slider and a hex field. No external libraries (strict CSP), no OS dialog.
 */
export function ColorPicker({ value, onChange }: Props): JSX.Element {
  // HSV is the source of truth while interacting; hue survives greys/blacks
  // (which a hex round-trip would otherwise collapse).
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(isValidHex(value) ? value : '#c0392b') ?? { h: 0, s: 0.75, v: 0.75 })
  const [hexText, setHexText] = useState<string>(isValidHex(value) ? value : '')

  const svRef = useRef<HTMLDivElement>(null)
  const hueRef = useRef<HTMLDivElement>(null)

  // Sync when the value is changed from outside (preset click, None, edit load)
  // and doesn't already match what our HSV produces.
  useEffect(() => {
    if (!isValidHex(value)) {
      setHexText('')
      return
    }
    const normalized = normalizeHex(value)!
    if (normalized.toLowerCase() === hsvToHex(hsv.h, hsv.s, hsv.v).toLowerCase()) {
      setHexText(normalized)
      return
    }
    const next = hexToHsv(normalized)
    if (next) {
      setHsv(next)
      setHexText(normalized)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const emit = useCallback(
    (next: Hsv) => {
      setHsv(next)
      const hex = hsvToHex(next.h, next.s, next.v)
      setHexText(hex)
      onChange(hex)
    },
    [onChange]
  )

  // --- drag handling ------------------------------------------------------

  const dragSV = useCallback(
    (clientX: number, clientY: number) => {
      const rect = svRef.current?.getBoundingClientRect()
      if (!rect) return
      const s = clamp01((clientX - rect.left) / rect.width)
      const v = 1 - clamp01((clientY - rect.top) / rect.height)
      emit({ ...hsv, s, v })
    },
    [emit, hsv]
  )

  const dragHue = useCallback(
    (clientX: number) => {
      const rect = hueRef.current?.getBoundingClientRect()
      if (!rect) return
      const h = clamp01((clientX - rect.left) / rect.width) * 360
      emit({ ...hsv, h })
    },
    [emit, hsv]
  )

  const makePointerHandler = (move: (x: number, y: number) => void) => (e: React.PointerEvent) => {
    e.preventDefault()
    // Guard: setPointerCapture throws if the pointer isn't active (e.g. synthetic
    // events in tests); dragging still works via the window listeners below.
    try {
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    move(e.clientX, e.clientY)
    const onMove = (ev: PointerEvent): void => move(ev.clientX, ev.clientY)
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const commitHex = (text: string): void => {
    const normalized = normalizeHex(text)
    if (normalized) {
      const next = hexToHsv(normalized)!
      setHsv(next)
      setHexText(normalized)
      onChange(normalized)
    } else {
      // Revert the field to the current colour.
      setHexText(hsvToHex(hsv.h, hsv.s, hsv.v))
    }
  }

  const currentHex = hsvToHex(hsv.h, hsv.s, hsv.v)
  const hueHex = hsvToHex(hsv.h, 1, 1)
  const hasColor = isValidHex(value)

  return (
    <div className="color-picker" style={{ width: SV_WIDTH }}>
      <div
        ref={svRef}
        className="cp-sv"
        style={{
          width: SV_WIDTH,
          height: SV_HEIGHT,
          backgroundColor: hueHex,
          backgroundImage:
            'linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0))'
        }}
        onPointerDown={makePointerHandler(dragSV)}
      >
        <div
          className="cp-sv-thumb"
          style={{
            left: `${hsv.s * SV_WIDTH}px`,
            top: `${(1 - hsv.v) * SV_HEIGHT}px`,
            background: currentHex
          }}
        />
      </div>

      <div
        ref={hueRef}
        className="cp-hue"
        style={{ width: SV_WIDTH, height: HUE_HEIGHT }}
        onPointerDown={makePointerHandler((x) => dragHue(x))}
      >
        <div className="cp-hue-thumb" style={{ left: `${(hsv.h / 360) * SV_WIDTH}px` }} />
      </div>

      <div className="cp-row">
        <span className="cp-preview" style={{ background: hasColor ? currentHex : 'transparent' }}>
          {!hasColor && <span className="cp-none-x">∅</span>}
        </span>
        <input
          className="field cp-hex"
          value={hexText}
          placeholder="No colour"
          spellCheck={false}
          onChange={(e) => setHexText(e.target.value)}
          onBlur={(e) => commitHex(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitHex((e.target as HTMLInputElement).value)
          }}
        />
        <button
          type="button"
          className="btn"
          style={{ minWidth: 0, height: 22, padding: '0 8px' }}
          onClick={() => onChange('')}
          disabled={!hasColor}
        >
          No colour
        </button>
      </div>

      <div className="cp-presets">
        {CONNECTION_COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            title={c.name}
            className="cp-preset"
            style={{
              background: c.value,
              outline: hasColor && currentHex.toLowerCase() === c.value.toLowerCase() ? '2px solid #1b1b1b' : undefined,
              outlineOffset: 1
            }}
            onClick={() => onChange(c.value)}
          >
            {hasColor && currentHex.toLowerCase() === c.value.toLowerCase() && (
              <span style={{ color: readableTextColor(c.value), fontSize: 10 }}>✓</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
