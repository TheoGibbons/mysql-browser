/** Small colour helpers for the per-connection colour feature. */

/** Preset swatches offered in the connection dialog. Red is first for prod. */
export const CONNECTION_COLORS: { name: string; value: string }[] = [
  { name: 'Production (red)', value: '#c0392b' },
  { name: 'Orange', value: '#d35400' },
  { name: 'Amber', value: '#c79000' },
  { name: 'Green', value: '#2e7d46' },
  { name: 'Teal', value: '#12766b' },
  { name: 'Blue', value: '#2a6fc9' },
  { name: 'Purple', value: '#7a3e9d' },
  { name: 'Grey', value: '#5a636b' }
]

interface Rgb {
  r: number
  g: number
  b: number
}

function hexToRgb(hex: string): Rgb | null {
  let value = hex.trim().replace(/^#/, '')
  if (value.length === 3) {
    value = value
      .split('')
      .map((c) => c + c)
      .join('')
  }
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16)
  }
}

function toHex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
}

/** Relative luminance (WCAG), 0 = black, 1 = white. */
function luminance(rgb: Rgb): number {
  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Near-black or white, whichever reads better on `hex`. */
export function readableTextColor(hex: string): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return '#1b1b1b'
  return luminance(rgb) > 0.55 ? '#1b1b1b' : '#ffffff'
}

/** Dimmed variant of the readable text colour, for secondary lines on a card. */
export function readableDimColor(hex: string): string {
  return readableTextColor(hex) === '#ffffff' ? 'rgba(255,255,255,0.82)' : 'rgba(0,0,0,0.6)'
}

/** Mixes `hex` toward white; `amount` is the fraction of the original kept. */
export function tint(hex: string, amount: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const mix = (c: number): number => c * amount + 255 * (1 - amount)
  return `#${toHex(mix(rgb.r))}${toHex(mix(rgb.g))}${toHex(mix(rgb.b))}`
}

export function isValidHex(hex: string | undefined | null): hex is string {
  return typeof hex === 'string' && hexToRgb(hex) !== null
}

/** Normalises `#abc`, `abc`, `#aabbcc` → `#aabbcc`, or null if unparseable. */
export function normalizeHex(hex: string): string | null {
  const rgb = hexToRgb(hex)
  return rgb ? `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}` : null
}

export interface Hsv {
  /** 0–360 */
  h: number
  /** 0–1 */
  s: number
  /** 0–1 */
  v: number
}

export function hexToHsv(hex: string): Hsv | null {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min

  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const s = max === 0 ? 0 : d / max
  return { h, s, v: max }
}

export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) {
    r = c
    g = x
  } else if (h < 120) {
    r = x
    g = c
  } else if (h < 180) {
    g = c
    b = x
  } else if (h < 240) {
    g = x
    b = c
  } else if (h < 300) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }
  return `#${toHex((r + m) * 255)}${toHex((g + m) * 255)}${toHex((b + m) * 255)}`
}
