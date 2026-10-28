import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SearchEngine } from '@beacon/core'
import { JsonFile } from '@beacon/jsonstore'
import type { Effects, ProviderContext, ResultItem } from '@beacon/shared'
import {
  HubSetupProvider,
  HubSourceProvider,
  classpad,
  cipherkeep,
  lorekeeper,
  worldloom,
  type IntegrationsFile,
  type SourceAdapter,
} from '../src/index'

let root: string
const j = (v: unknown) => JSON.stringify(v)
async function w(path: string, body: string) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
}
const NOW = new Date(2026, 9, 27, 12)

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'beacon-hub-'))
  // ---- Lorekeeper
  const lk = join(root, 'lk')
  await w(join(lk, 'meta.json'), j({ schemaVersion: 1 }))
  await w(join(lk, 'config/settings.json'), j({ labelOverrides: { extra1: 'Left off' } }))
  await w(
    join(lk, 'data/reading/romance.json'),
    j([
      {
        id: 'e1',
        library: 'reading',
        title: 'Moonlit Garden',
        altTitles: ['Garden of the Moon'],
        status: 'in_progress',
        current: { raw: 'Ch 120' },
        consumedUpTo: { raw: 'Ch 118' },
        notes: { extra1: 'ch 118 page 4' },
      },
      { id: 'e2', library: 'reading', title: 'Broken', status: 'planned' },
      { nope: true },
      'junk',
    ]),
  )
  await w(join(lk, 'data/watching/bad.json'), '{ not json')
  await w(
    join(lk, 'data/watching/future.json'),
    j({ schemaVersion: 99, items: [{ id: 'z', title: 'FUTURE_TITLE' }] }),
  )
  // ---- Cipherkeep
  const ck = join(root, 'ck')
  await w(
    join(ck, 'data/commands/files.json'),
    j({
      schemaVersion: 1,
      data: {
        items: [
          {
            id: 'c1',
            name: 'tar',
            title: 'tar',
            syntax: 'tar -czvf archive.tar.gz <dir>',
            whatItDoes: 'Archive files',
            risk: 'safe',
            examples: [{ command: 'tar -xzf a.tar.gz', description: 'extract' }],
            options: [{ flag: '-z', meaning: 'gzip' }],
          },
          { id: 'c2', name: 'dd', syntax: 'dd if=<in> of=<out>', risk: 'destructive' },
          { id: 'c3', name: 'old', syntax: 'old', archived: true },
        ],
      },
    }),
  )
  await w(
    join(ck, 'data/labs/htb.json'),
    j({
      schemaVersion: 1,
      data: {
        items: [
          {
            id: 'l1',
            title: 'Lame',
            platform: 'HTB',
            status: 'Completed',
            writeup: 'LAB_WRITEUP_SECRET flag{abc}',
            writeupPrivate: true,
          },
        ],
      },
    }),
  )
  await w(
    join(ck, 'data/concepts/net.json'),
    j({
      schemaVersion: 1,
      data: { items: [{ id: 'k1', title: 'Subnetting', difficulty: 'Medium' }] },
    }),
  )
  const ckEnc = join(root, 'ck-enc')
  await w(join(ckEnc, 'vault.json'), j({ salt: 'x' }))
  await w(join(ckEnc, 'data/commands/files.json'), 'CKENC1B\0garbage')
  // ---- Worldloom
  const wl = join(root, 'wl')
  const page = (fm: Record<string, unknown>, body = 'BODY_SECRET text') =>
    '---\n' +
    Object.entries(fm)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('\n') +
    '\n---\n' +
    body +
    '\n'
  await w(
    join(wl, 'worlds/demo/world.json'),
    j({
      name: 'Demo World',
      slug: 'demo',
      continuities: [{ id: 'main', isPrimary: true }],
      sources: [{ id: 'wn', continuityId: 'main' }],
      arcs: [
        { id: 'a1', order: 1, ranges: { wn: { from: 0, to: 10 } } },
        { id: 'a2', order: 2, ranges: { wn: { from: 11, to: 50 } } },
      ],
      progress: { sources: { wn: 10 }, showAll: true, revealed: ['p-gated'] },
    }),
  )
  await w(
    join(wl, 'worlds/demo/pages/character/hero.md'),
    page({
      id: 'p-hero',
      type: 'character',
      title: 'Public Hero',
      slug: 'hero',
      aliases: ['The Chosen'],
    }),
  )
  await w(
    join(wl, 'worlds/demo/pages/character/open-gate.md'),
    page({
      id: 'p-open',
      type: 'character',
      title: 'Early Reveal',
      slug: 'open-gate',
      reveal: { sourceId: 'wn', at: 5 },
    }),
  )
  await w(
    join(wl, 'worlds/demo/pages/character/gated.md'),
    page({
      id: 'p-gated',
      type: 'character',
      title: 'SECRET_TITLE_GATED',
      slug: 'gated',
      aliases: ['SECRET_ALIAS'],
      reveal: { sourceId: 'wn', at: 50 },
    }),
  )
  await w(
    join(wl, 'worlds/demo/pages/character/arc-gated.md'),
    page({
      id: 'p-arc',
      type: 'character',
      title: 'SECRET_ARC_TITLE',
      slug: 'arc-gated',
      reveal: { arcId: 'a2' },
    }),
  )
  await w(
    join(wl, 'worlds/demo/pages/character/weird.md'),
    page({
      id: 'p-weird',
      type: 'character',
      title: 'SECRET_WEIRD_GATE',
      slug: 'weird',
      reveal: 'someday',
    }),
  )
  await w(
    join(wl, 'worlds/demo/pages/character/dm.md'),
    page({ id: 'p-dm', type: 'character', title: 'SECRET_DM_PAGE', slug: 'dm', dmOnly: true }),
  )
  await w(
    join(wl, 'worlds/demo/pages/character/redir.md'),
    page({
      id: 'p-redir',
      type: 'character',
      title: 'SECRET_REDIRECT',
      slug: 'redir',
      redirectsTo: 'p-gated',
    }),
  )
  await w(join(wl, 'worlds/demo/pages/character/broken.md'), 'no frontmatter SECRET_BROKEN')
  await w(join(wl, 'worlds/noprogress/world.json'), '{ broken')
  await w(
    join(wl, 'worlds/noprogress/pages/x/p.md'),
    page({ id: 'q', type: 'x', title: 'SECRET_UNKNOWN_WORLD', slug: 'p' }),
  )
  // ---- Classpad
  const cp = join(root, 'cp')
  await w(
    join(cp, 'data/classes/fall.json'),
    j({
      schemaVersion: 1,
      items: [{ id: 'cl1', name: 'Biology', code: 'BIOL 1610', gradingSchemeId: 'g' }],
    }),
  )
  await w(
    join(cp, 'data/assignments/fall/biol.json'),
    j({
      schemaVersion: 1,
      items: [
        {
          id: 'a1',
          classId: 'cl1',
          title: 'Lab report 3',
          status: 'in_progress',
          due: '2026-10-27',
          score: { earned: 87.3123 },
          weight: 17.77,
          pointsPossible: 313,
          quickNotes: 'GRADE_NOTE_SECRET',
        },
        {
          id: 'a2',
          classId: 'cl1',
          title: 'Overdue essay',
          status: 'not_started',
          due: '2026-10-20',
          score: 91.4567,
        },
        {
          id: 'a3',
          classId: 'cl1',
          title: 'Finished quiz',
          status: 'complete',
          due: '2026-10-25',
          score: 99.9999,
        },
        {
          id: 'a4',
          classId: 'cl1',
          title: 'Far future project',
          status: 'not_started',
          due: '2027-03-01',
        },
        {
          id: 'a5',
          classId: 'cl1',
          title: 'Next week reading response',
          status: 'not_started',
          due: '2026-11-02',
        },
      ],
    }),
  )
  await w(
    join(cp, 'data/assignments/fall/enc.json'),
    '{"classpad":"enc1","iv":"x","tag":"y","data":"z"}',
  )
  await w(
    join(cp, 'data/tasks/tasks.json'),
    j({
      schemaVersion: 1,
      items: [
        { id: 't1', title: 'Study for midterm', date: '2026-10-27', done: false },
        { id: 't2', title: 'Done task', done: true },
      ],
    }),
  )
  await w(
    join(cp, 'data/notes/biol/entropy.md'),
    '---\nid: n1\ntitle: Entropy basics\nclassId: cl1\n---\nNOTE_BODY_SECRET 99.5%\n',
  )
})
afterAll(() => rm(root, { recursive: true, force: true }))

const load = (a: SourceAdapter, dir: string, showSpoilers = false) =>
  a.load(join(root, dir), { now: NOW, showSpoilers })
const dump = (v: unknown) => JSON.stringify(v)

describe('Lorekeeper adapter', () => {
  it('reads titles, status, progress and the left-off bookmark; skips bad/newer files', async () => {
    const r = await load(lorekeeper, 'lk')
    const e = r.items.find((i) => i.title === 'Moonlit Garden')!
    expect(e.subtitle).toBe('Reading · in progress · at Ch 120')
    expect(e.keywords).toEqual(['Garden of the Moon'])
    expect(e.preview?.value).toContain('Left off: ch 118 page 4')
    expect(e.actions?.some((a) => a.title.includes('Left off'))).toBe(true)
    expect(r.items.map((i) => i.title)).toEqual(['Moonlit Garden', 'Broken'])
    expect(r.warnings.some((x) => x.includes('bad.json'))).toBe(true)
    expect(r.warnings.some((x) => x.includes('newer schema'))).toBe(true)
    expect(dump(r)).not.toContain('FUTURE_TITLE')
  })
})

describe('Cipherkeep adapter', () => {
  it('copy-syntax primary, examples, risk flag; no lab write-ups; archived skipped', async () => {
    const r = await load(cipherkeep, 'ck')
    const tar = r.items.find((i) => i.title === 'tar')!
    expect(tar.primary).toMatchObject({
      kind: 'copy',
      payload: { text: 'tar -czvf archive.tar.gz <dir>' },
    })
    expect(
      tar.actions?.some((a) => (a.payload as { text?: string })?.text === 'tar -xzf a.tar.gz'),
    ).toBe(true)
    expect(tar.preview?.value).toContain('Archive files')
    expect(r.items.find((i) => i.title === 'dd')?.subtitle).toContain('destructive')
    expect(r.items.some((i) => i.title === 'old')).toBe(false)
    expect(r.items.find((i) => i.title === 'Lame')?.subtitle).toBe('Lab · HTB · Completed')
    expect(dump(r)).not.toMatch(/LAB_WRITEUP_SECRET|flag\{/)
  })
  it('skips an encrypted vault instead of reading it', async () => {
    const r = await load(cipherkeep, 'ck-enc')
    expect(r.items).toEqual([])
    expect(r.warnings[0]).toMatch(/encryption is on/)
  })
})

describe('Worldloom adapter: spoiler safety', () => {
  const SECRETS = [
    'SECRET_TITLE_GATED',
    'SECRET_ALIAS',
    'SECRET_ARC_TITLE',
    'SECRET_WEIRD_GATE',
    'SECRET_DM_PAGE',
    'SECRET_REDIRECT',
    'SECRET_BROKEN',
    'SECRET_UNKNOWN_WORLD',
    'BODY_SECRET',
  ]
  it('only ungated and satisfied pages appear (the app showAll/revealed flags are NOT honoured)', async () => {
    const r = await load(worldloom, 'wl')
    expect(r.items.map((i) => i.title).sort()).toEqual(['Early Reveal', 'Public Hero'])
    expect(r.items.find((i) => i.title === 'Public Hero')?.keywords).toEqual(['The Chosen'])
    for (const s of SECRETS) expect(dump(r.items)).not.toContain(s)
  })
  it('warnings never contain gated titles either', async () => {
    const r = await load(worldloom, 'wl')
    for (const s of SECRETS) expect(dump(r.warnings)).not.toContain(s)
  })
  it('control: with spoilers explicitly on, gated pages DO appear (the checks can fail)', async () => {
    const r = await load(worldloom, 'wl', true)
    const titles = r.items.map((i) => i.title)
    expect(titles).toContain('SECRET_TITLE_GATED')
    expect(titles).toContain('SECRET_ARC_TITLE')
    expect(titles).not.toContain('SECRET_DM_PAGE') // DM-only is never shown
    expect(dump(r.items)).not.toContain('BODY_SECRET') // bodies are never included
  })
  it('end to end through the engine: no probe query or log line leaks a gated string', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    )
    const cfg = new JsonFile<IntegrationsFile>({
      path: join(root, 'int-wl.json'),
      schema: z.record(z.any()),
      defaults: () => ({ worldloom: { enabled: true, deepLinks: true, showSpoilers: false } }),
    })
    await cfg.load()
    const p = new HubSourceProvider(worldloom, cfg)
    // point the adapter at the fixture via config.dir
    await cfg.set({
      worldloom: { enabled: true, deepLinks: true, showSpoilers: false, dir: join(root, 'wl') },
    })
    const e = new SearchEngine({ ctx: { now: Date.now } })
    e.register(p)
    const seen: ResultItem[] = []
    for (const q of [
      '',
      'secret',
      'SECRET_TITLE',
      'secret_alias',
      'gated',
      'hero',
      'wl secret',
      'wl ',
      'chosen',
      'body',
      'dm',
      'redirect',
      'arc',
      'weird',
      'unknown',
    ])
      await e.search(q, (b) => seen.push(...b.items))
    await e.search('hero', (b) => seen.push(...b.items))
    expect(seen.length).toBeGreaterThan(0)
    for (const s of SECRETS) expect(dump(seen)).not.toContain(s)
    for (const spy of spies) expect(dump(spy.mock.calls)).not.toMatch(/SECRET/)
    spies.forEach((s) => s.mockRestore())
  })
})

describe('Classpad adapter: grade safety', () => {
  const GRADE_STRINGS = [
    '87.3123',
    '91.4567',
    '99.9999',
    '17.77',
    '313',
    'GRADE_NOTE_SECRET',
    'NOTE_BODY_SECRET',
    '99.5',
  ]
  it('deadlines/tasks/notes only; grades, weights, points, quick notes and bodies never present', async () => {
    const r = await load(classpad, 'cp')
    const titles = r.items.map((i) => i.title).sort()
    expect(titles).toEqual([
      'Entropy basics',
      'Lab report 3',
      'Next week reading response',
      'Overdue essay',
      'Study for midterm',
    ])
    expect(r.items.find((i) => i.title === 'Lab report 3')?.subtitle).toBe('BIOL 1610 · due today')
    expect(r.items.find((i) => i.title === 'Overdue essay')?.today).toBe(true)
    expect(
      r.items.some((i) => ['Finished quiz', 'Far future project', 'Done task'].includes(i.title)),
    ).toBe(false)
    for (const s of GRADE_STRINGS) expect(dump(r)).not.toContain(s)
    expect(r.warnings.some((x) => x.includes('encrypted') || x.includes('skipped'))).toBe(true)
  })
  it('end to end: empty state shows today/overdue deadlines; results never include grades', async () => {
    const cfg = new JsonFile<IntegrationsFile>({
      path: join(root, 'int-cp.json'),
      schema: z.record(z.any()),
      defaults: () => ({}),
    })
    await cfg.load()
    await cfg.set({
      classpad: { enabled: true, deepLinks: true, showSpoilers: false, dir: join(root, 'cp') },
    })
    const p = new HubSourceProvider(classpad, cfg)
    const e = new SearchEngine({ ctx: { now: Date.now } })
    e.register(p)
    const empty: ResultItem[] = []
    await e.search('', (b) => empty.push(...b.items))
    expect(empty.map((i) => i.title).sort()).toEqual([
      'Lab report 3',
      'Overdue essay',
      'Study for midterm',
    ])
    const all: ResultItem[] = []
    for (const q of ['lab', 'essay', 'cp ', 'cp biol', 'entropy', 'grade', 'score'])
      await e.search(q, (b) => all.push(...b.items))
    for (const s of GRADE_STRINGS) expect(dump(all)).not.toContain(s)
    expect(all.find((i) => i.title === 'Lab report 3')?.primary).toMatchObject({
      kind: 'deeplink',
      payload: { url: 'classpad://open?type=assignment&id=a1' },
    })
  })
})

describe('hub provider + setup', () => {
  it('is off until enabled (with confirmation), then searches; deep links default to launching the app on macOS', async () => {
    const cfg = new JsonFile<IntegrationsFile>({
      path: join(root, 'int-all.json'),
      schema: z.record(z.any()),
      defaults: () => ({}),
    })
    await cfg.load()
    await cfg.set({
      lorekeeper: { enabled: false, deepLinks: false, showSpoilers: false, dir: join(root, 'lk') },
      cipherkeep: { enabled: false, deepLinks: false, showSpoilers: false, dir: join(root, 'ck') },
    })
    const providers = new Map<string, HubSourceProvider>([
      ['lorekeeper', new HubSourceProvider(lorekeeper, cfg)],
      ['cipherkeep', new HubSourceProvider(cipherkeep, cfg)],
    ])
    const setup = new HubSetupProvider([lorekeeper, cipherkeep], cfg, providers)
    const copied: string[] = []
    const fx: Effects = {
      copy: async (t) => void copied.push(t),
      openUrl: async () => {},
      notify: async () => {},
      readClipboard: async () => '',
      copyImage: async () => {},
      openPath: async () => {},
      openDeepLink: async () => {},
      reveal: async () => {},
      bindHotkey: async () => {},
    }
    const ctx: ProviderContext = { now: Date.now, effects: fx }
    const e = new SearchEngine({ ctx })
    e.register(setup)
    for (const p of providers.values()) e.register(p)
    const run = async (q: string) => {
      const o: ResultItem[] = []
      await e.search(q, (b) => o.push(...b.items))
      return o
    }

    expect(await run('moonlit')).toEqual([]) // disabled: nothing read, nothing shown
    const hub = await run('hub ')
    const enableLk = hub.find((i) => i.id === 'hub:lorekeeper')!
    expect(enableLk.primary).toMatchObject({ id: 'enable', confirm: true })
    await setup.activate(enableLk.id, undefined, ctx)
    const hits = await run('moonlit')
    expect(hits[0]?.title).toBe('Moonlit Garden')
    expect(['run', 'deeplink']).toContain(hits[0]?.primary.kind)
    expect(hits[0]?.actions?.some((a) => a.id === 'copy-link')).toBe(true)

    await setup.activate('hub:cipherkeep', undefined, ctx)
    const tar = (await run('cmd tar'))[0]!
    expect(tar.title).toBe('tar')
    await providers.get('cipherkeep')!.activate(tar.id, undefined, ctx)
    expect(copied.at(-1)).toBe('tar -czvf archive.tar.gz <dir>')
    // disabling clears results immediately
    await run('hub ') // results are per-query; refresh so the item now offers "Disable"
    await setup.activate('hub:lorekeeper', undefined, ctx)
    expect(await run('moonlit')).toEqual([])
  })
})
