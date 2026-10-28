import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SearchEngine } from '@beacon/core'
import { JsonFile } from '@beacon/jsonstore'
import type { ProviderContext, ResultItem } from '@beacon/shared'
import {
  BookmarksProvider,
  FileIndex,
  FilesProvider,
  SshProvider,
  applyFilters,
  crawl,
  discoverBookmarkProfiles,
  everythingSource,
  locateSource,
  makeIgnore,
  mdfindSource,
  parseChromiumBookmarks,
  parseGitignore,
  parseKnownHosts,
  parseSshConfig,
  readFirefoxBookmarks,
  terminalHere,
  terminalRun,
  textPreview,
  DEFAULT_IGNORE_NAMES,
  type FilesConfig,
} from '../src/index'

let dir: string
const w = (rel: string, body = 'x') =>
  mkdir(join(dir, rel, '..'), { recursive: true }).then(() => writeFile(join(dir, rel), body))
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'beacon-m6-'))
  await w('home/Documents/report final.pdf')
  await w('home/Documents/notes.md', '# Title\nhello preview')
  await w('home/Projects/app/src/index.ts')
  await w('home/Projects/app/node_modules/dep/index.js')
  await w('home/Projects/app/.git/config')
  await w('home/Projects/app/dist/out.js')
  await w('home/Projects/app/.gitignore', 'dist\n*.log\n# c\n')
  await w('home/Projects/app/debug.log')
  await w('home/Library/Caches/junk.bin')
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const names = (es: { path: string }[]) => es.map((e) => e.path.slice(dir.length + 1)).sort()

describe('crawl', () => {
  const base = () => ({
    roots: [join(dir, 'home')],
    ignore: makeIgnore(DEFAULT_IGNORE_NAMES),
    maxFiles: 1000,
  })
  it('skips node_modules, .git, Library and hidden entries', async () => {
    const got = names(await crawl(base()))
    expect(got).toContain('home/Documents/report final.pdf')
    expect(got).toContain('home/Projects/app/src/index.ts')
    expect(got.some((p) => /node_modules|\.git|Library|junk/.test(p))).toBe(false)
  })
  it('honors .gitignore when enabled', async () => {
    const got = names(await crawl({ ...base(), gitignore: true }))
    expect(got.some((p) => p.endsWith('debug.log') || p.includes('/dist'))).toBe(false)
    expect(names(await crawl(base())).some((p) => p.endsWith('debug.log'))).toBe(true)
    expect(parseGitignore('/build\n*.tmp\n!keep\n').globs).toHaveLength(1)
  })
  it('caps the file count and can be cancelled', async () => {
    expect((await crawl({ ...base(), maxFiles: 3 })).length).toBe(3)
    const ctl = new AbortController()
    ctl.abort()
    expect(await crawl({ ...base(), signal: ctl.signal })).toEqual([])
  })
  it('reports progress', async () => {
    const seen: number[] = []
    await crawl({ ...base(), yieldEvery: 2, onProgress: (n) => seen.push(n) })
    expect(seen.length).toBeGreaterThan(1)
  })
})

describe('FileIndex + provider', () => {
  const ctx: ProviderContext = { now: Date.now }
  const cfg: FilesConfig = {
    source: 'builtin',
    roots: [],
    maxFiles: 1000,
    gitignore: false,
    ignoreNames: [],
    ignoreGlobs: [],
  }
  async function build() {
    const idx = new FileIndex()
    await idx.rebuildFromDisk({
      roots: [join(dir, 'home')],
      ignore: makeIgnore(DEFAULT_IGNORE_NAMES),
      maxFiles: 1000,
    })
    return idx
  }
  const run = async (e: SearchEngine, q: string) => {
    const o: ResultItem[] = []
    await e.search(q, (b) => o.push(...b.items))
    return o
  }

  it('searches by name, supports ext:/in:/type: filters and previews', async () => {
    const idx = await build()
    const e = new SearchEngine({ ctx })
    e.register(new FilesProvider(idx, () => cfg))
    expect((await run(e, 'report'))[0]?.title).toBe('report final.pdf')
    expect((await run(e, 'index ext:ts')).map((i) => i.title)).toEqual(['index.ts'])
    expect((await run(e, 'app type:folder in:Projects')).every((i) => i.kind === 'folder')).toBe(
      true,
    )
    const notes = (await run(e, 'notes'))[0]!
    expect(notes.preview?.value).toContain('hello preview')
    expect(notes.primary.kind).toBe('open')
    expect(notes.actions?.map((a) => a.id)).toEqual(['reveal', 'copy', 'terminal'])
  })
  it('applies incremental add/remove and round-trips the cache file', async () => {
    const idx = await build()
    idx.add('/x/new-file.txt', false)
    expect(idx.search('new-file', 5)).toHaveLength(1)
    idx.remove('/x/new-file.txt')
    expect(idx.search('new-file', 5)).toHaveLength(0)
    const f = join(dir, 'cache/index.txt')
    await idx.save(f)
    const idx2 = new FileIndex()
    expect(await idx2.load(f)).toBe(true)
    expect(idx2.size).toBe(idx.size)
    expect(await new FileIndex().load(join(dir, 'nope'))).toBe(false)
  })
  it('filters helper', () => {
    const es = [
      { path: '/a/b.PDF', isDir: false },
      { path: '/a/docs', isDir: true },
    ]
    expect(applyFilters(es, { ext: 'pdf' })).toHaveLength(1)
    expect(applyFilters(es, { type: 'folder' })).toHaveLength(1)
  })
  it('text preview only for small text files', async () => {
    expect(await textPreview(join(dir, 'home/Documents/notes.md'))).toContain('Title')
    expect(await textPreview(join(dir, 'home/Documents/report final.pdf'))).toBeNull()
  })
})

describe('external file sources (argv only)', () => {
  it('passes queries as a single argv element, never to a shell', async () => {
    const calls: [string, string[]][] = []
    const exec = async (f: string, a: string[]) => (calls.push([f, a]), '/a/one\n/a/two\n')
    const nasty = 'x"; rm -rf / && $(id) `y`'
    expect(await mdfindSource(exec).search(nasty, 10, new AbortController().signal)).toEqual([
      '/a/one',
      '/a/two',
    ])
    await locateSource(exec).search(nasty, 10, new AbortController().signal)
    await everythingSource(exec).search(nasty, 10, new AbortController().signal)
    expect(calls[0]).toEqual(['mdfind', ['-name', nasty]])
    expect(calls[1]![1]).toEqual(['-i', '-b', '-l', '10', '--', nasty])
    expect(calls[2]![1]).toEqual(['-n', '10', nasty])
  })
  it('provider uses a configured source and applies filters', async () => {
    const idx = new FileIndex()
    const src = {
      id: 'spotlight',
      available: async () => true,
      search: async () => [
        join(dir, 'home/Documents/notes.md'),
        join(dir, 'home/Documents/report final.pdf'),
      ],
    }
    const e = new SearchEngine({ ctx: { now: Date.now } })
    e.register(
      new FilesProvider(
        idx,
        () => ({
          source: 'spotlight',
          roots: [],
          maxFiles: 1,
          gitignore: false,
          ignoreNames: [],
          ignoreGlobs: [],
        }),
        { spotlight: src },
      ),
    )
    const o: ResultItem[] = []
    await e.search('f anything ext:pdf', (b) => o.push(...b.items))
    expect(o.map((i) => i.title)).toEqual(['report final.pdf'])
  })
})

describe('ssh', () => {
  it('parses hosts, Include, ignores wildcards, never reads keys', async () => {
    await w(
      'ssh/config',
      `Include conf.d/*.conf\nHost *\n  User nobody\nHost prod web1\n  HostName 10.0.0.5\n  User deploy\n  Port 2222\n  IdentityFile ~/.ssh/id_ed25519\nHost bad;alias "quoted host"\nHost !neg dev-*\nHost lab\n  HostName=lab.local\n`,
    )
    await w('ssh/conf.d/extra.conf', 'Host extra\n  HostName extra.example\n')
    await w(
      'ssh/known_hosts',
      'github.com,140.82.1.1 ssh-ed25519 AAAA\n|1|hashed|hash ssh-rsa AAAA\n[example.org]:2222 ssh-rsa AAAA\n',
    )
    const hosts = await parseSshConfig(join(dir, 'ssh/config'))
    const text = await (await import('node:fs/promises')).readFile(join(dir, 'ssh/config'), 'utf8')
    expect(text).toContain('Include conf.d')
    // Include paths are relative to ~/.ssh; the fixture dir isn't, so extra.conf is found only via absolute include:
    expect(hosts.map((h) => h.alias).sort()).toEqual(['lab', 'prod', 'web1'])
    expect(hosts.find((h) => h.alias === 'prod')).toMatchObject({
      hostName: '10.0.0.5',
      user: 'deploy',
      port: '2222',
    })
    expect(hosts.find((h) => h.alias === 'lab')?.hostName).toBe('lab.local')
    expect(await parseKnownHosts(join(dir, 'ssh/known_hosts'))).toEqual([
      'github.com',
      '140.82.1.1',
      'example.org',
    ])
    await w('ssh/abs', `Include ${join(dir, 'ssh/conf.d/*.conf')}\nHost a\n`)
    expect((await parseSshConfig(join(dir, 'ssh/abs'))).map((h) => h.alias).sort()).toEqual([
      'a',
      'extra',
    ])
  })
  it('terminal commands are argv; unsafe words are rejected', () => {
    expect(terminalRun('win32', ['ssh', 'prod'])).toEqual({ file: 'wt.exe', args: ['ssh', 'prod'] })
    expect(terminalRun('linux', ['ssh', 'prod'], { command: ['kitty'] })).toEqual({
      file: 'kitty',
      args: ['ssh', 'prod'],
    })
    expect(terminalRun('darwin', ['ssh', 'prod']).file).toBe('osascript')
    for (const bad of ['a b', 'x";do shell script "id', '$(id)', 'a;b'])
      expect(() => terminalRun('darwin', ['ssh', bad])).toThrow()
    expect(terminalHere('linux', '/tmp/a b', { command: ['kitty'] })).toEqual({
      file: 'kitty',
      args: [],
      cwd: '/tmp/a b',
    })
    expect(terminalHere('darwin', '/Users/example/My Dir').args).toEqual([
      '-a',
      'Terminal',
      '/Users/example/My Dir',
    ])
  })
  it('provider lists hosts and refuses unknown aliases', async () => {
    const p = new SshProvider(join(dir, 'ssh/config'), 'linux', () => ({ command: ['true'] }))
    const e = new SearchEngine({ ctx: { now: Date.now } })
    e.register(p)
    const o: ResultItem[] = []
    await e.search('ssh prod', (b) => o.push(...b.items))
    expect(o[0]?.title).toBe('prod')
    await expect(p.activate('ssh:prod', undefined, { now: Date.now })).resolves.toBeUndefined()
    await expect(p.activate('ssh:prod', 'nope', { now: Date.now })).rejects.toThrow()
  })
})

describe('bookmarks', () => {
  const chrome = JSON.stringify({
    roots: {
      bookmark_bar: {
        type: 'folder',
        name: 'Bar',
        children: [
          { type: 'url', name: 'Example', url: 'https://example.com/' },
          {
            type: 'folder',
            name: 'Dev',
            children: [{ type: 'url', name: 'MDN', url: 'https://developer.mozilla.org/' }],
          },
        ],
      },
      other: {
        type: 'folder',
        name: 'Other',
        children: [{ type: 'url', name: 'Evil', url: 'javascript:alert(1)' }],
      },
    },
  })
  it('parses Chromium bookmarks with folders', () => {
    const b = parseChromiumBookmarks(chrome)
    expect(b.map((x) => x.title)).toEqual(['Example', 'MDN', 'Evil'])
    expect(b[1]?.folder).toBe('Bar/Dev')
    expect(parseChromiumBookmarks('not json')).toEqual([])
  })
  it('reads Firefox places.sqlite from a copy (WASM sqlite)', async () => {
    const initSqlJs = (await import('sql.js')).default
    const SQL = await initSqlJs()
    const db = new SQL.Database()
    db.run(
      'CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT); CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, title TEXT);',
    )
    db.run("INSERT INTO moz_places VALUES (1,'https://firefox.example/a'),(2,'place:folder=1')")
    db.run(
      "INSERT INTO moz_bookmarks VALUES (1,1,1,'FF Bookmark'),(2,2,NULL,'folder'),(3,1,2,'place query')",
    )
    const file = join(dir, 'places.sqlite')
    await writeFile(file, Buffer.from(db.export()))
    expect(await readFirefoxBookmarks(file)).toEqual([
      { title: 'FF Bookmark', url: 'https://firefox.example/a' },
    ])
  })
  it('discovers profiles; provider is opt-in per profile and only opens http(s)', async () => {
    const home = join(dir, 'fakehome')
    const base = join(home, '.config/google-chrome')
    await mkdir(join(base, 'Default'), { recursive: true })
    await mkdir(join(base, 'Profile 2'), { recursive: true })
    await writeFile(join(base, 'Default/Bookmarks'), chrome)
    await writeFile(join(base, 'Profile 2/Bookmarks'), chrome)
    const profiles = await discoverBookmarkProfiles('linux', home)
    expect(profiles.map((p) => p.id)).toEqual(['chrome:Default', 'chrome:Profile 2'])

    const cfg = new JsonFile({
      path: join(dir, 'bm.json'),
      schema: z.object({ enabled: z.array(z.string()) }),
      defaults: () => ({ enabled: [] as string[] }),
    })
    const p = new BookmarksProvider(cfg, async () => profiles)
    const e = new SearchEngine({ ctx: { now: Date.now } })
    e.register(p)
    const run = async (q: string) => {
      const o: ResultItem[] = []
      await e.search(q, (b) => o.push(...b.items))
      return o
    }
    const setup = await run('bm ')
    expect(setup.every((i) => i.id.startsWith('enable:'))).toBe(true) // nothing read before opting in
    await p.activate(setup[0]!.id, undefined, { now: Date.now })
    const hits = await run('bm mdn')
    expect(hits[0]?.title).toBe('MDN')
    expect((await run('bm evil')).some((i) => i.title === 'Evil')).toBe(false) // javascript: URLs dropped
  })
})
