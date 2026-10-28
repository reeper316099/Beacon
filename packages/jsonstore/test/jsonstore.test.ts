import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { JsonFile } from '../src/index'

let dir: string
beforeAll(async () => (dir = await mkdtemp(join(tmpdir(), 'beacon-js-'))))
afterAll(() => rm(dir, { recursive: true, force: true }))

const schema = z.object({ n: z.number(), s: z.string().default('x') })
const mk = (name: string, extra = {}) =>
  new JsonFile({
    path: join(dir, name),
    schema,
    defaults: () => ({ n: 0, s: 'x' }),
    version: 2,
    ...extra,
  })

describe('JsonFile', () => {
  it('returns defaults when missing, persists atomically with schemaVersion', async () => {
    const f = mk('a.json')
    expect(await f.load()).toEqual({ n: 0, s: 'x' })
    await f.set({ n: 1, s: 'y' })
    const disk = JSON.parse(await readFile(f.path, 'utf8'))
    expect(disk).toEqual({ n: 1, s: 'y', schemaVersion: 2 })
    expect((await readdir(dir)).some((x) => x.endsWith('.tmp'))).toBe(false)
  })
  it('serializes concurrent writes (last queued wins, file never torn)', async () => {
    const f = mk('b.json')
    await Promise.all(Array.from({ length: 30 }, (_, i) => f.set({ n: i, s: 'z'.repeat(i * 100) })))
    const disk = JSON.parse(await readFile(f.path, 'utf8'))
    expect(disk.n).toBe(29)
  })
  it('rejects invalid values without clobbering', async () => {
    const f = mk('c.json')
    await f.set({ n: 5, s: 'k' })
    expect(() => f.set({ n: 'bad' } as never)).toThrow()
    expect(f.data.n).toBe(5)
  })
  it('quarantines corrupt files and restores the last good backup', async () => {
    const f = mk('d.json', { onError: () => {} })
    await f.set({ n: 1, s: 'a' })
    await f.set({ n: 2, s: 'b' }) // backup now holds n:1
    await writeFile(f.path, '{ not json')
    const g = mk('d.json', { onError: () => {} })
    expect(await g.load()).toEqual({ n: 1, s: 'a' })
    expect((await readdir(dir)).some((x) => x.startsWith('d.json.corrupt-'))).toBe(true)
  })
  it('runs migrations by stored version', async () => {
    await writeFile(join(dir, 'e.json'), JSON.stringify({ count: 7 }))
    const f = mk('e.json', {
      migrate: (raw: { count?: number; n?: number }, v: number) => (v < 2 ? { n: raw.count } : raw),
    })
    expect(await f.load()).toEqual({ n: 7, s: 'x' })
  })
  it('keeps a bounded number of backups', async () => {
    const f = mk('f.json', { backups: 2 })
    for (let i = 0; i < 6; i++) {
      await f.set({ n: i, s: 's' })
      await new Promise((r) => setTimeout(r, 3))
    }
    const b = (await readdir(join(dir, '.backups'))).filter((x) => x.startsWith('f.json.'))
    expect(b.length).toBe(2)
  })
})
