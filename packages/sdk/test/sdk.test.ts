import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseManifest } from '@beacon/providers/extensions'
import { emit, notify, progress } from '../src/index'
import { runDev, scaffold } from '../src/dev'

let dir: string
beforeAll(async () => (dir = await mkdtemp(join(tmpdir(), 'beacon-sdk-'))))
afterAll(() => rm(dir, { recursive: true, force: true }))

describe('script helpers', () => {
  it('emit/notify/progress print the documented protocol', () => {
    const out: string[] = []
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((s) => (out.push(String(s)), true))
    emit({ title: 'T', value: 'v' })
    notify('Done', 'ok')
    progress(0.5, 'half')
    spy.mockRestore()
    expect(JSON.parse(out[0]!)).toEqual({ title: 'T', value: 'v' })
    expect(out[1]).toBe('@@beacon {"type":"notify","title":"Done","body":"ok"}\n')
    expect(out[2]).toBe('@@beacon {"type":"progress","value":0.5,"label":"half"}\n')
  })
})

describe('extension scaffold + dev runner', () => {
  it('scaffolds a valid extension that runs in the sandbox and reports what it asks for', async () => {
    const ext = join(dir, 'my-ext')
    await scaffold(ext, 'my-ext', 'My Extension')
    expect(parseManifest(await readFile(join(ext, 'manifest.json'), 'utf8')).ok).toBe(true)
    const log: string[] = []
    const items = await runDev(ext, 'Ada', (s) => log.push(s))
    expect(items[0]?.title).toBe('Hello, Ada!')
    expect(items[0]?.primary).toMatchObject({ kind: 'copy', payload: { text: 'Hello, Ada!' } })
  })
  it('rejects bad ids', async () => {
    await expect(scaffold(join(dir, 'x'), 'Bad Id', 'x')).rejects.toThrow(/id must be/)
  })
})
