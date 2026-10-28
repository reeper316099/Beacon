import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BACKOFF_MS,
  ExtensionHost,
  Grants,
  MAX_CRASHES,
  describePermission,
  parseManifest,
  parsePermission,
  sanitizeItems,
  type ExtPlatform,
  type ExtProc,
  type LoadedExtension,
} from '../src/index'
import { createSandbox, serveExtension } from '../src/extensions/sandbox-entry'

const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    apiVersion: 1,
    main: 'index.js',
    commands: [{ keyword: 'dm', title: 'Demo' }],
    permissions: [],
    ...over,
  })

describe('manifest validation', () => {
  it('accepts a good manifest and parses permissions', () => {
    const r = parseManifest(
      manifest({
        permissions: [
          'clipboard.read',
          'notifications',
          'storage',
          'fs.read:/tmp/data',
          'exec:git,/usr/bin/curl',
          'network:api.example.com,*.example.org',
        ],
      }),
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.permissions).toHaveLength(6)
      expect(r.manifest.permissions.map(describePermission)[3]).toBe('Read files under /tmp/data')
    }
  })
  it('rejects malicious or malformed manifests', () => {
    const bad: Record<string, unknown>[] = [
      { main: '../../etc/passwd.js' },
      { main: '/abs/path.js' },
      { main: 'index.txt' },
      { id: '../evil' },
      { id: 'A' },
      { apiVersion: 2 },
      { version: 'latest' },
      { permissions: ['root'] },
      { permissions: ['fs.read:/'] },
      { permissions: ['fs.read:relative/path'] },
      { permissions: ['fs.write:/tmp/../etc'] },
      { permissions: ['exec:'] },
      { permissions: ['exec:rm -rf /; x'] },
      { permissions: ['network:evil.com/path'] },
      { permissions: ['network:'] },
      { permissions: Array(30).fill('storage') },
      { commands: [{ keyword: 'a b', title: 'x' }] },
      { extra: 'field' },
    ]
    for (const b of bad) expect(parseManifest(manifest(b)).ok, JSON.stringify(b)).toBe(false)
    expect(parseManifest('{nope').ok).toBe(false)
    expect(parseManifest('x'.repeat(70_000)).ok).toBe(false)
    expect(parsePermission('fs.read:C:\\')).toBeNull()
  })
})

describe('Grants: default deny', () => {
  let dir: string
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'beacon-ext-')))
    await mkdir(join(dir, 'allowed'), { recursive: true })
    await mkdir(join(dir, 'secret'), { recursive: true })
    await symlink(join(dir, 'secret'), join(dir, 'allowed', 'link'))
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))
  const g = (...p: string[]) =>
    new Grants(
      p.map((s) => parsePermission(s)!),
      (x) => realpath(x),
    )

  it('denies everything without grants', async () => {
    const none = g()
    for (const o of [
      { op: 'clipboard.read' },
      { op: 'clipboard.write' },
      { op: 'notify' },
      { op: 'storage' },
      { op: 'fs.read', path: '/etc/hosts' },
      { op: 'exec', file: 'ls' },
      { op: 'fetch', url: 'https://example.com' },
    ] as const)
      expect(await none.check(o)).toMatch(/needs|permission|outside/)
  })
  it('simple grants', async () => {
    const x = g('clipboard.read', 'notifications')
    expect(await x.check({ op: 'clipboard.read' })).toBeNull()
    expect(await x.check({ op: 'clipboard.write' })).not.toBeNull()
    expect(await x.check({ op: 'notify' })).toBeNull()
  })
  it('fs scope: inside ok, outside and symlink-escape denied, prefix tricks denied', async () => {
    const x = g(`fs.read:${join(dir, 'allowed')}`)
    expect(await x.check({ op: 'fs.read', path: join(dir, 'allowed', 'file.txt') })).toBeNull()
    expect(await x.check({ op: 'fs.read', path: join(dir, 'secret') })).not.toBeNull()
    expect(await x.check({ op: 'fs.read', path: join(dir, 'allowed', 'link') })).not.toBeNull() // resolves outside
    expect(
      await x.check({ op: 'fs.read', path: join(dir, 'allowed', '..', 'secret') }),
    ).not.toBeNull()
    expect(await x.check({ op: 'fs.write', path: join(dir, 'allowed', 'f') })).not.toBeNull() // read ≠ write
    await mkdir(join(dir, 'allowed-evil'), { recursive: true })
    expect(await x.check({ op: 'fs.read', path: join(dir, 'allowed-evil') })).not.toBeNull()
  })
  it('exec is an exact allow-list; network per host, wildcard subdomains only', async () => {
    const x = g('exec:git', 'network:api.example.com,*.cdn.test')
    expect(await x.check({ op: 'exec', file: 'git' })).toBeNull()
    expect(await x.check({ op: 'exec', file: 'rm' })).not.toBeNull()
    expect(await x.check({ op: 'exec', file: '/bin/git' })).not.toBeNull()
    expect(await x.check({ op: 'fetch', url: 'https://api.example.com/v1' })).toBeNull()
    expect(await x.check({ op: 'fetch', url: 'https://evil.com' })).not.toBeNull()
    expect(await x.check({ op: 'fetch', url: 'https://api.example.com.evil.com' })).not.toBeNull()
    expect(await x.check({ op: 'fetch', url: 'https://a.cdn.test/x' })).toBeNull()
    expect(await x.check({ op: 'fetch', url: 'https://cdn.test/x' })).not.toBeNull()
    expect(await x.check({ op: 'fetch', url: 'file:///etc/passwd' })).not.toBeNull()
  })
})

describe('QuickJS sandbox', () => {
  const calls: [string, string][] = []
  const mk = (code: string) =>
    createSandbox({
      code,
      onCall: async (op, args) => (
        calls.push([op, args]),
        JSON.stringify({ ok: true, value: `host:${op}` })
      ),
    })

  it('runs extension code and passes data in/out as JSON', async () => {
    const s = await mk(
      'module.exports = { query: async (q) => [{ id: "1", title: "Hi " + q.text }], echo: (a, b, ctx) => ({ a, b, hasCtx: typeof ctx }) }',
    )
    expect(await s.invoke('query', [{ text: 'x' }])).toEqual([{ id: '1', title: 'Hi x' }])
    expect(await s.invoke('echo', [1, 'two'])).toEqual({ a: 1, b: 'two', hasCtx: 'object' })
    s.dispose()
  })
  it('ctx calls go to the host', async () => {
    const s = await mk(
      'module.exports = { go: async (_x, ctx) => (await ctx.clipboard.read()) + "|" + (await ctx.storage.get("k")) }',
    )
    expect(await s.invoke('go', [null])).toBe('host:clipboard.read|host:storage.get')
    s.dispose()
  })
  it('has no Node/DOM globals and cannot reach the host (escape attempts)', async () => {
    const attempts = [
      'typeof process',
      'typeof require',
      'typeof Buffer',
      'typeof fetch',
      'typeof XMLHttpRequest',
      'typeof globalThis.__call',
      'this.constructor.constructor("return typeof process")()',
      '(async()=>{}).constructor("return typeof process")()',
      'Object.getPrototypeOf(ctx).constructor.constructor("return typeof process")()',
      'typeof WebAssembly',
      'typeof setTimeout',
    ].map((x) => `(() => { try { return ${x} } catch (e) { return "blocked" } })()`)
    const s = await mk(`module.exports = { probe: async (_x, ctx) => [${attempts.join(',')}] }`)
    const r = (await s.invoke('probe', [null])) as string[]
    expect(r.slice(0, 6)).toEqual(Array(6).fill('undefined'))
    // A leaked host `process` would show as the string "object"; a promise from the async constructor serializes to {}.
    for (const v of r.slice(6, 9)) expect(['object', 'function']).not.toContain(v)
    expect(r[6]).toBe('undefined')
    expect(r[8]).toMatch(/undefined|blocked/)
    s.dispose()
  })
  it('ctx is frozen; cannot be tampered with', async () => {
    const s = await mk(
      'module.exports = { t: async (_x, ctx) => { "use strict"; try { ctx.clipboard.read = () => "pwned"; ctx.evil = 1; } catch (e) {} return [typeof ctx.evil, await ctx.clipboard.read()] } }',
    )
    expect(await s.invoke('t', [null])).toEqual(['undefined', 'host:clipboard.read'])
    s.dispose()
  })
  it('infinite loops are interrupted, memory bombs fail, errors propagate', async () => {
    const s = await createSandbox({
      code: 'module.exports = { loop: () => { while (true) {} }, bomb: () => { const a = []; for (;;) a.push(new Array(1e6).fill(1)) }, boom: () => { throw new Error("bad thing") } }',
      onCall: async () => '{}',
      invokeTimeoutMs: 300,
      memoryLimitBytes: 8 * 1024 * 1024,
    })
    const t = Date.now()
    await expect(s.invoke('loop', [])).rejects.toThrow()
    expect(Date.now() - t).toBeLessThan(3000)
    await expect(s.invoke('bomb', [])).rejects.toThrow()
    await expect(s.invoke('boom', [])).rejects.toThrow(/bad thing/)
    await expect(s.invoke('nothing', [])).rejects.toThrow(/does not implement/)
    s.dispose()
  })
  it('a syntax error fails loading cleanly', async () => {
    await expect(mk('module.exports = {')).rejects.toThrow(/failed to load/)
  })
})

// ---- host + runner wired through an in-memory transport ----
function inMemoryProc(opts: { crashOnQuery?: boolean } = {}): {
  proc: ExtProc
  exit(code?: number): void
} {
  let toHost: (m: unknown) => void = () => {}
  let toRunner: (m: unknown) => void = () => {}
  let onExit: (c: number | null) => void = () => {}
  let dead = false
  const q = (fn: () => void) => queueMicrotask(() => !dead && fn())
  serveExtension({ send: (m) => q(() => toHost(m)), onMessage: (cb) => (toRunner = cb) })
  const proc: ExtProc = {
    send: (m) => {
      if (opts.crashOnQuery && (m as { type?: string; method?: string }).method === 'query')
        return void queueMicrotask(() => ((dead = true), onExit(1)))
      q(() => toRunner(m))
    },
    onMessage: (cb) => (toHost = cb),
    onExit: (cb) => (onExit = cb),
    kill: () => (dead = true),
  }
  return { proc, exit: (c = 1) => ((dead = true), onExit(c)) }
}

const platform = (log: string[], clip = 'CLIPBOARD'): ExtPlatform => ({
  clipboardRead: async () => (log.push('clip.read'), clip),
  clipboardWrite: async (t) => void log.push('clip.write:' + t),
  notify: async (_n, t) => void log.push('notify:' + t),
  fsRead: async (p) => (log.push('fs.read:' + p), 'FILE'),
  fsWrite: async () => {},
  exec: async (f, a) => (
    log.push('exec:' + f + ' ' + a.join(' ')),
    { code: 0, stdout: 'ok', stderr: '' }
  ),
  fetch: async (u) => (log.push('fetch:' + u), { status: 200, body: 'B' }),
  storageGet: async () => null,
  storageSet: async () => {},
  realpath: async (p) => p,
})

const ext = (code: string, perms: string[] = []): LoadedExtension => {
  const r = parseManifest(manifest({ permissions: perms }))
  if (!r.ok) throw new Error(r.error)
  return { manifest: r.manifest, code }
}

describe('ExtensionHost', () => {
  it('queries an extension, sanitizes its output, and enforces permissions per call', async () => {
    const log: string[] = []
    const code = `module.exports = {
      query: async (q, ctx) => {
        let denied = 'none'
        try { await ctx.clipboard.write('x') } catch (e) { denied = e.message }
        const clip = await ctx.clipboard.read()
        return [
          { id: 'a', title: 'clip=' + clip, subtitle: denied, primary: { id: 'c', title: 'Copy', kind: 'copy', payload: { text: 'hello' } } },
          { id: 'b', title: 'bad url', primary: { id: 'u', title: 'Open', kind: 'url', payload: { url: 'javascript:alert(1)' } } },
          { id: 'c', title: 'runs', primary: { id: 'r', title: 'Run', kind: 'run', payload: { file: 'git', args: ['status'] } } },
          { id: 'd', title: 'x'.repeat(5000), primary: { id: 'c', title: 'Copy', kind: 'copy', payload: { text: 't' } } },
          { id: 'e', title: 'file', primary: { id: 'o', title: 'Open', kind: 'open', payload: { path: 'relative/evil' } } },
        ]
      }, activate: async (id, action, ctx) => { await ctx.notify('did ' + id + '/' + action) } }`
    const host = new ExtensionHost(() => inMemoryProc().proc, platform(log))
    host.load(ext(code, ['clipboard.read', 'notifications']))
    const items = await host.query('demo', { text: 'q', terms: ['q'] }, 2000)
    expect(items.map((i) => i.id)).toEqual(['ext:demo:a', 'ext:demo:c']) // javascript: url, huge title, relative path all dropped
    expect(items[0]).toMatchObject({
      title: 'clip=CLIPBOARD',
      providerId: 'ext:demo',
      kind: 'extension',
    })
    expect(items[0]!.subtitle).toMatch(/permission denied.*clipboard\.write/)
    expect(items[1]!.primary).toMatchObject({ kind: 'run', confirm: true }) // programs from extensions always confirm
    expect(log).toContain('clip.read')
    expect(log.some((l) => l.startsWith('clip.write'))).toBe(false)
    await host.activate('demo', 'x', 'act')
    expect(log).toContain('notify:did x/act')
  })

  it('network and exec stay off unless granted, even when the code tries', async () => {
    const log: string[] = []
    const code = `module.exports = { query: async (q, ctx) => { const out = []; for (const f of [() => ctx.fetch('https://example.com'), () => ctx.exec('ls', []), () => ctx.fs.read('/etc/passwd')]) { try { await f(); out.push('ALLOWED') } catch (e) { out.push('denied') } } return [{ id: 'r', title: out.join(','), primary: { id: 'c', title: 'c', kind: 'copy', payload: { text: 'x' } } }] } }`
    const host = new ExtensionHost(() => inMemoryProc().proc, platform(log))
    host.load(ext(code))
    expect((await host.query('demo', { text: '', terms: [] }, 2000))[0]?.title).toBe(
      'denied,denied,denied',
    )
    expect(log).toEqual([])
    host.load(ext(code, ['network:example.com', 'exec:ls']))
    expect((await host.query('demo', { text: '', terms: [] }, 2000))[0]?.title).toBe(
      'ALLOWED,ALLOWED,denied',
    )
    expect(log).toEqual(['fetch:https://example.com', 'exec:ls '])
  })

  it('crash recovery: restarts with backoff, requests fail cleanly, gives up after repeated crashes', async () => {
    const timers: { fn: () => void; ms: number }[] = []
    let spawns = 0
    let current: ReturnType<typeof inMemoryProc> | undefined
    const host = new ExtensionHost(
      () => (spawns++, (current = inMemoryProc())).proc,
      platform([]),
      { timer: { set: (fn, ms) => (timers.push({ fn, ms }), timers.length), clear: () => {} } },
    )
    host.load(ext('module.exports = { query: () => new Promise(() => {}) }'))
    expect(spawns).toBe(1)
    const pending = host
      .query('demo', { text: '', terms: [] }, 60_000)
      .catch((e: Error) => e.message)
    await new Promise((r) => setTimeout(r, 50))
    current!.exit(139) // crash while a request is in flight
    expect(await pending).toMatch(/crashed/)
    expect(host.state('demo')).toBe('restarting')
    await expect(host.query('demo', { text: '', terms: [] })).rejects.toThrow(/restarting/)
    const restartDelays: number[] = []
    for (let i = 0; i < MAX_CRASHES + 2 && host.state('demo') !== 'crashed'; i++) {
      const t = timers.at(-1)!
      restartDelays.push(t.ms)
      t.fn() // restart
      current!.exit(1) // crash again
    }
    expect(restartDelays.slice(0, 4)).toEqual(BACKOFF_MS.slice(0, 4)) // growing backoff
    expect(host.state('demo')).toBe('crashed')
    host.unload('demo')
    expect(host.state('demo')).toBeUndefined()
  })

  it('a hung extension times out without blocking others', async () => {
    const host = new ExtensionHost(() => inMemoryProc().proc, platform([]))
    host.load(ext('module.exports = { query: () => new Promise(() => {}) }'))
    const t = Date.now()
    await expect(host.query('demo', { text: '', terms: [] }, 150)).rejects.toThrow(/timed out/)
    expect(Date.now() - t).toBeLessThan(1500)
  })

  it('sanitizeItems tolerates garbage', () => {
    expect(sanitizeItems('x', 'nope')).toEqual([])
    expect(sanitizeItems('x', [{ nonsense: true }])).toEqual([])
    expect(sanitizeItems('x', null)).toEqual([])
  })
})
