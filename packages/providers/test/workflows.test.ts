import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SearchEngine } from '@beacon/core'
import type { Effects, ProviderContext, ResultItem } from '@beacon/shared'
import {
  WorkflowProvider,
  WorkflowStore,
  fill,
  needsConfirm,
  parseWorkflow,
  runWorkflow,
} from '../src/index'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'beacon-wf-'))
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'search.json'),
    JSON.stringify({
      id: 'search',
      name: 'Search both',
      keyword: 'sb',
      args: [{ name: 'term', prompt: 'What?' }],
      steps: [
        { kind: 'url', url: 'https://example.com/?q={term}' },
        { kind: 'copy', text: 'searched {term}' },
      ],
    }),
  )
  await writeFile(
    join(dir, 'dev.yaml'),
    'id: dev\nname: Dev setup\nkeyword: dev\nsteps:\n  - kind: run\n    file: git\n    args: [status]\n  - kind: wait\n    ms: 1\n',
  )
  await writeFile(join(dir, 'broken.json'), '{ "id": "x" }')
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const fx = (log: string[]): Effects => ({
  copy: async (t) => void log.push('copy:' + t),
  openUrl: async (u) => void log.push('url:' + u),
  notify: async () => {},
  readClipboard: async () => 'CLIP',
  copyImage: async () => {},
  openPath: async (p) => void log.push('open:' + p),
  openDeepLink: async () => {},
  reveal: async () => {},
  bindHotkey: async () => {},
})

describe('workflows', () => {
  it('parses JSON and YAML, rejects bad ones with a reason', () => {
    expect(
      parseWorkflow('{"id":"a","name":"A","keyword":"a","steps":[{"kind":"wait","ms":5}]}', '.json')
        .ok,
    ).toBe(true)
    expect(
      parseWorkflow('id: a\nname: A\nkeyword: a\nsteps:\n  - kind: copy\n    text: hi', '.yaml').ok,
    ).toBe(true)
    for (const bad of [
      '{"id":"A B","name":"x","keyword":"k","steps":[{"kind":"wait","ms":1}]}',
      '{"id":"a","name":"x","keyword":"k","steps":[]}',
      '{"id":"a","name":"x","keyword":"k","steps":[{"kind":"shell","cmd":"rm -rf /"}]}',
      '{"id":"a","name":"x","keyword":"k","steps":[{"kind":"wait","ms":999999}]}',
      'nope{',
    ]) {
      const r = parseWorkflow(bad, '.json')
      expect(r.ok).toBe(false)
    }
  })
  it('substitutes values as data (URL values are encoded)', async () => {
    expect(fill('a {x} b {y} {none}', { x: '1', y: '2' })).toBe('a 1 b 2 {none}')
    const log: string[] = []
    const w = parseWorkflow(
      JSON.stringify({
        id: 'a',
        name: 'A',
        keyword: 'a',
        steps: [
          { kind: 'url', url: 'https://e.com/?q={query}' },
          { kind: 'copy', text: '{clipboard}|{query}' },
        ],
      }),
      '.json',
    )
    if (!w.ok) throw new Error(w.error)
    await runWorkflow(
      w.workflow,
      { query: 'a b&c=d; rm -rf /' },
      { ctx: { now: Date.now, effects: fx(log) } },
    )
    expect(log).toEqual([
      'url:https://e.com/?q=a%20b%26c%3Dd%3B%20rm%20-rf%20%2F',
      'copy:CLIP|a b&c=d; rm -rf /',
    ])
  })
  it('url steps only open http(s); failures name the step; os filter skips steps', async () => {
    const mk = (steps: unknown[]) => {
      const r = parseWorkflow(JSON.stringify({ id: 'a', name: 'A', keyword: 'a', steps }), '.json')
      if (!r.ok) throw new Error(r.error)
      return r.workflow
    }
    const log: string[] = []
    const ctx: ProviderContext = { now: Date.now, effects: fx(log) }
    await expect(
      runWorkflow(
        mk([
          { kind: 'copy', text: 'ok' },
          { kind: 'url', url: 'javascript:alert(1)' },
        ]),
        {},
        { ctx },
      ),
    ).rejects.toThrow(/step 2 \(url\)/)
    expect(log).toEqual(['copy:ok'])
    log.length = 0
    await runWorkflow(
      mk([
        { kind: 'copy', text: 'mac', os: ['macos'] },
        { kind: 'copy', text: 'win', os: ['windows'] },
      ]),
      {},
      { ctx, platform: 'darwin' },
    )
    expect(log).toEqual(['copy:mac'])
  })
  it('run steps use argv with no shell; scripts go through the trusted runner', async () => {
    const w = parseWorkflow(
      JSON.stringify({
        id: 'a',
        name: 'A',
        keyword: 'a',
        steps: [
          {
            kind: 'run',
            file: process.execPath,
            args: ['-e', 'process.exit(process.argv[1] === "a; b && c" ? 0 : 9)', '{query}'],
          },
          { kind: 'script', script: 'backup', args: ['{query}'] },
        ],
      }),
      '.json',
    )
    if (!w.ok) throw new Error(w.error)
    const ran: string[][] = []
    await runWorkflow(
      w.workflow,
      { query: 'a; b && c' },
      {
        ctx: { now: Date.now },
        runScript: async (ref, args) => (ran.push([ref, ...args]), { ok: true }),
      },
    )
    expect(ran).toEqual([['backup', 'a; b && c']])
    expect(needsConfirm(w.workflow)).toBe(true)
  })
  it('store loads files, reports problems; provider routes keywords, confirms run steps, runs through activate', async () => {
    const store = new WorkflowStore(dir)
    await store.load()
    expect(store.workflows.map((w) => w.id).sort()).toEqual(['dev', 'search'])
    expect(store.problems[0]).toMatch(/broken\.json/)
    const log: string[] = []
    const ctx: ProviderContext = { now: Date.now, effects: fx(log) }
    const p = new WorkflowProvider(store)
    p.refreshTriggers()
    const e = new SearchEngine({ ctx })
    e.register(p)
    const run = async (q: string) => {
      const o: ResultItem[] = []
      await e.search(q, (b) => o.push(...b.items))
      return o
    }
    const [sb] = await run('sb cats and dogs')
    expect(sb?.title).toBe('Run “Search both”')
    expect(sb?.primary.confirm).toBe(false)
    await p.activate(sb!.id, undefined, ctx)
    expect(log).toEqual([
      'url:https://example.com/?q=cats%20and%20dogs',
      'copy:searched cats and dogs',
    ])
    const [dev] = await run('dev ')
    expect(dev?.primary.confirm).toBe(true) // contains a run step
    expect((await run('workflows ')).length).toBeGreaterThanOrEqual(3)
  })
})
