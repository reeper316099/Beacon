import { deflateSync } from 'node:zlib'
import { nativeImage, type NativeImage } from 'electron'

function crc32(buf: Buffer): number {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** Generated ring icon (no bundled trademark art). Black + alpha so macOS can template it. */
export function trayIcon(size = 32): NativeImage {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  const c = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c)
      const ring = Math.max(0, Math.min(1, 1 - Math.abs(d - size * 0.32) / (size * 0.1)))
      const dot = Math.max(0, Math.min(1, size * 0.1 + 0.5 - d))
      const a = Math.round(255 * Math.max(ring, dot))
      const o = y * (size * 4 + 1) + 1 + x * 4
      raw[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  const img = nativeImage.createFromBuffer(png, { scaleFactor: size / 16 })
  img.setTemplateImage(true)
  return img
}
