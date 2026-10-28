// Generates the app icon (apps/desktop/build/icon.png, 1024x1024) with no external tools or artwork:
// a rounded dark square with a gradient ring and a bright dot (a "beacon").
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const N = 1024
const buf = Buffer.alloc(N * (N * 4 + 1))
const c = (N - 1) / 2
const lerp = (a, b, t) => a + (b - a) * t
const sstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
const A = [124, 140, 255]
const B = [180, 140, 255]
for (let y = 0; y < N; y++) {
  buf[y * (N * 4 + 1)] = 0
  for (let x = 0; x < N; x++) {
    // rounded-square mask (macOS-style squircle-ish)
    const dx = Math.abs(x - c) / (N * 0.46),
      dy = Math.abs(y - c) / (N * 0.46)
    const sq = Math.pow(Math.pow(dx, 5) + Math.pow(dy, 5), 1 / 5)
    const mask = 1 - sstep(0.985, 1.0, sq)
    const d = Math.hypot(x - c, y - c)
    const ring = 1 - Math.min(1, Math.abs(d - N * 0.27) / (N * 0.045))
    const dot = 1 - sstep(N * 0.085, N * 0.095, d)
    const glow = Math.exp(-Math.pow((d - N * 0.27) / (N * 0.12), 2)) * 0.35
    const t = (x + y) / (2 * N)
    const bg = [lerp(26, 38, t), lerp(28, 32, t), lerp(40, 66, t)]
    const col = [lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)]
    let r = bg[0],
      g = bg[1],
      b = bg[2]
    const k = Math.max(0, ring) * 0.95 + glow
    r = lerp(r, col[0], Math.min(1, k))
    g = lerp(g, col[1], Math.min(1, k))
    b = lerp(b, col[2], Math.min(1, k))
    r = lerp(r, 255, dot)
    g = lerp(g, 255, dot)
    b = lerp(b, 255, dot)
    const o = y * (N * 4 + 1) + 1 + x * 4
    buf[o] = r
    buf[o + 1] = g
    buf[o + 2] = b
    buf[o + 3] = Math.round(255 * mask)
  }
}
function crc32(b) {
  let c = ~0
  for (const x of b) {
    c ^= x
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(N, 0)
ihdr.writeUInt32BE(N, 4)
ihdr[8] = 8
ihdr[9] = 6
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(buf, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])
const out = join(import.meta.dirname, '../apps/desktop/build')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'icon.png'), png)
console.log('wrote', join(out, 'icon.png'), png.length, 'bytes')
