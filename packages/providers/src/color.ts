export interface Rgb {
  r: number
  g: number
  b: number
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export function parseColor(input: string): Rgb | null {
  const s = input.trim().toLowerCase()
  let m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s)
  if (m && (s.startsWith('#') || m[1]!.length === 6)) {
    let h = m[1] as string
    if (h.length === 3) h = [...h].map((c) => c + c).join('')
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    }
  }
  m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(s)
  if (m) return { r: clamp(+m[1]!, 0, 255), g: clamp(+m[2]!, 0, 255), b: clamp(+m[3]!, 0, 255) }
  m =
    /^hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(
      s,
    )
  if (m) return hslToRgb(((+m[1]! % 360) + 360) % 360, clamp(+m[2]!, 0, 100), clamp(+m[3]!, 0, 100))
  return null
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const S = s / 100
  const L = l / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = S * Math.min(L, 1 - L)
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) }
}

export function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const R = r / 255,
    G = g / 255,
    B = b / 255
  const max = Math.max(R, G, B),
    min = Math.min(R, G, B)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l: Math.round(l * 100) }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  h = Math.round((h * 60 + 360) % 360)
  return { h, s: Math.round(s * 100), l: Math.round(l * 100) }
}

export const toHex = ({ r, g, b }: Rgb): string =>
  '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')

export function conversions(c: Rgb): { label: string; value: string }[] {
  const hsl = rgbToHsl(c)
  return [
    { label: 'HEX', value: toHex(c) },
    { label: 'RGB', value: `rgb(${c.r}, ${c.g}, ${c.b})` },
    { label: 'HSL', value: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)` },
  ]
}
