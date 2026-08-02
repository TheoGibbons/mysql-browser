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
