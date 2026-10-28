import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SearchEngine } from '@beacon/core'
import { JsonFile } from '@beacon/jsonstore'
import type { Effects, ProviderContext, ResultItem } from '@beacon/shared'
import {
  AliasProvider,
  BindProvider,
  ClipboardProvider,
  ClipboardStore,
  NotesProvider,
  PinStore,
  PinsProvider,
  SnippetProvider,
  TodoProvider,
  dueToday,
  expandSnippet,
  parseTodo,
  type AliasMap,
  type Note,
  type Snippet,
  type Todo,
} from '../src/index'

let dir: string
beforeAll(async () => (dir = await mkdtemp(join(tmpdir(), 'beacon-m5-'))))
afterAll(() => rm(dir, { recursive: true, force: true }))

const DAY = 86_400_000

describe('ClipboardStore', () => {
  const mk = (extra = {}, t = { v: 1_000_000 }) => ({
    t,
    s: new ClipboardStore({ path: join(dir, `c${Math.random()}.jsonl`), now: () => t.v, ...extra }),
  })
  it('dedupes by content and moves to top', () => {
    const { s } = mk()
    s.addText('a')
    s.addText('b')
    s.addText('a')
    expect(s.list().map((e) => e.text)).toEqual(['a', 'b'])
  })
  it('ignores paused, concealed, empty, oversized and regex-excluded copies', () => {
    const { s } = mk({ ignore: [/^sk-[A-Za-z0-9]{10,}$/], maxTextBytes: 10 })
    expect(s.addText('sk-abcdefghijkl')).toBeNull()
    expect(s.addText('hunter2', { concealed: true })).toBeNull()
    expect(s.addText('   ')).toBeNull()
    expect(s.addText('x'.repeat(11))).toBeNull()
    s.paused = true
    expect(s.addText('ok')).toBeNull()
    s.paused = false
    expect(s.addText('ok')).not.toBeNull()
    expect(s.list()).toHaveLength(1)
  })
  it('retention and max items drop old unpinned entries; pinned survive', () => {
    const { s, t } = mk({ maxItems: 3, retentionMs: 7 * DAY })
    s.addText('keep')
    s.togglePin(s.list()[0]!.id)
    for (const x of ['1', '2', '3', '4']) {
      t.v += 1000
      s.addText(x)
    }
    expect(s.list().map((e) => e.text)).toEqual(['keep', '4', '3', '2'])
    t.v += 8 * DAY
    s.prune()
    expect(s.list().map((e) => e.text)).toEqual(['keep'])
  })
  it('wipe clears everything and returns image hashes; persists as jsonl and reloads', async () => {
    const { s } = mk()
    s.addText('x')
    s.addImage('abc', 100)
    await s.flush()
    const s2 = new ClipboardStore({
      path: (s as unknown as { o: { path: string } }).o.path,
      now: () => 1_000_000,
    })
    await s2.load()
    expect(s2.list()).toHaveLength(2)
    expect(s.wipe()).toEqual(['abc'])
    await s.flush()
    expect((await readFile((s as unknown as { o: { path: string } }).o.path, 'utf8')).trim()).toBe(
      '',
    )
  })
  it('results are sensitive and hidden from the global list; only the cb trigger shows them', async () => {
    const { s } = mk()
    s.addText('secret-ish note')
    const e = new SearchEngine({ ctx: { now: () => 1_000_000 } })
    e.register(new ClipboardProvider(s))
    const got: ResultItem[] = []
    await e.search('secret', (b) => got.push(...b.items))
    expect(got).toEqual([]) // prefix-only provider, not in the default list
    await e.search('cb secret', (b) => got.push(...b.items))
    expect(got[0]?.sensitive).toBe(true)
    expect(got[0]?.title).toContain('secret-ish')
  })
})

describe('snippets', () => {
  it('expands placeholders', () => {
    const out = expandSnippet(
      'Hi {prompt:name}, {date:YYYY-MM-DD HH:mm} — {clipboard}{cursor} {unknown}',
      {
        now: new Date(2026, 0, 5, 9, 7),
        clipboard: 'CLIP',
        prompts: { name: 'Ben' },
      },
    )
    expect(out).toBe('Hi Ben, 2026-01-05 09:07 — CLIP {unknown}')
  })
  it('creates, searches, expands and deletes through the provider', async () => {
    const file = new JsonFile<Snippet[]>({
      path: join(dir, 'snip.json'),
      schema: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          body: z.string(),
          tags: z.array(z.string()),
          folder: z.string(),
        }),
      ),
      defaults: () => [],
    })
    const copied: string[] = []
    const fx: Effects = {
      copy: async (t) => void copied.push(t),
      openUrl: async () => {},
      notify: async () => {},
      readClipboard: async () => 'C',
      copyImage: async () => {},
      openPath: async () => {},
      reveal: async () => {},
      bindHotkey: async () => {},
    }
    const ctx: ProviderContext = { now: () => new Date(2026, 0, 5).getTime(), effects: fx }
    const e = new SearchEngine({ ctx })
    const p = new SnippetProvider(file)
    e.register(p)
    const run = async (q: string) => {
      const o: ResultItem[] = []
      await e.search(q, (b) => o.push(...b.items))
      return o
    }
    const [mk] = await run('snip new Greeting :: Hello {prompt:who} on {date:DD/MM}')
    await p.activate(mk!.id, undefined, ctx)
    expect(file.data).toHaveLength(1)
    const [hit] = await run('snip greet who=Ada')
    expect(hit?.subtitle).not.toContain('needs')
    await p.activate(hit!.id, undefined, ctx)
    expect(copied.at(-1)).toBe('Hello Ada on 05/01')
    const [needs] = await run('snip greet')
    expect(needs?.subtitle).toContain('who=')
    await p.activate(needs!.id, 'delete', ctx)
    expect(file.data).toHaveLength(0)
  })
})

describe('notes and todos', () => {
  const now = new Date(2026, 5, 15)
  it('parses due dates', () => {
    expect(parseTodo('pay rent due:tomorrow', now)).toEqual({ text: 'pay rent', due: '2026-06-16' })
    expect(parseTodo('call mom !today', now)).toEqual({ text: 'call mom', due: '2026-06-15' })
    expect(parseTodo('x !2026-07-01', now)).toEqual({ text: 'x', due: '2026-07-01' })
    expect(parseTodo('plain', now)).toEqual({ text: 'plain' })
  })
  it('due-today surfaces overdue and today, not done or future', () => {
    const t = (id: string, due: string | undefined, done = false): Todo => ({
      id,
      text: id,
      done,
      ts: 0,
      ...(due ? { due } : {}),
    })
    expect(
      dueToday(
        [
          t('a', '2026-06-14'),
          t('b', '2026-06-15'),
          t('c', '2026-06-16'),
          t('d', '2026-06-15', true),
          t('e', undefined),
        ],
        now,
      ).map((x) => x.id),
    ).toEqual(['a', 'b'])
  })
  it('adds, toggles and deletes', async () => {
    const todoSchema = z.array(
      z.object({
        id: z.string(),
        text: z.string(),
        done: z.boolean(),
        due: z.string().optional(),
        ts: z.number(),
      }),
    )
    const tf = new JsonFile<Todo[]>({
      path: join(dir, 'todos.json'),
      schema: todoSchema,
      defaults: () => [],
    })
    const nf = new JsonFile<Note[]>({
      path: join(dir, 'notes.json'),
      schema: z.array(z.object({ id: z.string(), text: z.string(), ts: z.number() })),
      defaults: () => [],
    })
    const ctx: ProviderContext = { now: () => now.getTime() }
    const e = new SearchEngine({ ctx })
    const todos = new TodoProvider(tf),
      notes = new NotesProvider(nf)
    e.register(todos)
    e.register(notes)
    const run = async (q: string) => {
      const o: ResultItem[] = []
      await e.search(q, (b) => o.push(...b.items))
      return o
    }
    await todos.activate((await run('todo buy milk due:today'))[0]!.id, undefined, ctx)
    expect(tf.data[0]).toMatchObject({ text: 'buy milk', due: '2026-06-15', done: false })
    const listed = (await run('todo '))[0]!
    expect(listed.title).toBe('○ buy milk')
    await todos.activate(listed.id, undefined, ctx)
    expect(tf.data[0]!.done).toBe(true)
    await notes.activate((await run('note remember the milk'))[0]!.id, undefined, ctx)
    expect(nf.data[0]!.text).toBe('remember the milk')
  })
})

describe('pins and aliases', () => {
  const item = (id: string, extra = {}): ResultItem => ({
    id,
    providerId: 'apps',
    title: id,
    kind: 'app',
    score: 10,
    primary: { id: 'launch', title: 'Open', kind: 'open', payload: null },
    ...extra,
  })
  it('pins (not sensitive items) show on the empty query', async () => {
    const f = new JsonFile<ResultItem[]>({
      path: join(dir, 'pins.json'),
      schema: z.array(z.any()),
      defaults: () => [],
    })
    const pins = new PinStore(f)
    expect(await pins.toggle(item('Firefox'))).toBe(true)
    expect(await pins.toggle(item('secret', { sensitive: true }))).toBe(false)
    const e = new SearchEngine()
    e.register(new PinsProvider(pins))
    const empty: ResultItem[] = []
    await e.search('', (b) => empty.push(...b.items))
    expect(empty.map((i) => i.id)).toEqual(['Firefox'])
    expect(await pins.toggle(item('Firefox'))).toBe(false)
  })
  it('aliases resolve to the target provider/item; bind command resolves the top result', async () => {
    const af = new JsonFile<AliasMap>({
      path: join(dir, 'aliases.json'),
      schema: z.record(z.any()),
      defaults: () => ({}),
    })
    const ctx: ProviderContext = { now: Date.now }
    const e = new SearchEngine({ ctx })
    const bind = new BindProvider('alias', 'Alias', af, async (t) =>
      t === 'firefox' ? item('Firefox') : undefined,
    )
    e.register(bind)
    e.register(new AliasProvider(af))
    const run = async (q: string) => {
      const o: ResultItem[] = []
      await e.search(q, (b) => o.push(...b.items))
      return o
    }
    const [mk] = await run('alias ff firefox')
    expect(mk?.title).toContain('Firefox')
    await bind.activate(mk!.id, undefined, ctx)
    const [hit] = await run('ff')
    expect(hit).toMatchObject({ providerId: 'apps', id: 'Firefox', score: 5000 })
    expect((await run('alias zz nothing'))[0]?.title).toContain('No result')
  })
})
