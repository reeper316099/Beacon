import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { parseQuery, SearchEngine } from '@beacon/core'
import type { Effects, ProviderContext } from '@beacon/shared'
import {
  CalculatorProvider,
  ColorProvider,
  DevProvider,
  EmojiProvider,
  QuicklinkProvider,
  SystemProvider,
  TimerProvider,
  TimerStore,
  b64dec,
  b64enc,
  buildUrl,
  calculate,
  conversions,
  evalDate,
  evalTimezone,
  filterProcs,
  formatRemaining,
  hash,
  isCritical,
  jwtDecode,
  lorem,
  parseColor,
  parseDuration,
  parsePs,
  parseTasklist,
  password,
  regexTest,
  systemCommands,
  timestamp,
  ulid,
  withTone,
} from '../src/index'

const now = new Date(2026, 5, 15, 12, 0, 0) // local noon, Jun 15 2026 (Monday)
const r = (s: string) => calculate(s, now)?.raw ?? null

describe('calculator', () => {
  it('arithmetic', () => {
    expect(r('23*1.08')).toBe('24.84')
    expect(r('2^10')).toBe('1024')
    expect(r('sqrt(144)')).toBe('12')
    expect(r('(1+2)*3')).toBe('9')
  })
  it('percent', () => {
    expect(r('15% of 80')).toBe('12')
    expect(r('20% off 50')).toBe('40')
  })
  it('units', () => {
    expect(r('5 km to mile')).toMatch(/^3\.1\d* mile/)
    expect(r('100 fahrenheit to celsius')).toMatch(/37\.7/)
    expect(r('1 GB to MB')).toMatch(/1000 MB|1024 MB/)
  })
  it('bases', () => {
    expect(r('255 to hex')).toBe('0xff')
    expect(r('0xff to dec')).toBe('255')
    expect(r('10 to bin')).toBe('0b1010')
  })
  it('date math', () => {
    expect(evalDate('today + 45 days', now)?.raw).toBe('Thursday, 2026-07-30')
    expect(evalDate('3 days ago', now)?.raw).toContain('2026-06-12')
    expect(evalDate('today - 2 months', now)?.raw).toContain('2026-04-15')
  })
  it('timezones', () => {
    const out = evalTimezone('3pm PST in Tokyo', now)!.raw
    expect(out).toMatch(/7:00 AM/) // 3pm LA (PDT, UTC-7) = 22:00 UTC = 7am JST next day
  })
  it('does not treat words or plain numbers as results', () => {
    expect(r('chrome')).toBeNull()
    expect(r('42')).toBeNull()
    expect(r('hello world')).toBeNull()
  })
  it('sandbox: injection attempts fail safely', () => {
    const evil = [
      'constructor',
      'this.constructor.constructor("return process")()',
      'process.exit()',
      '__proto__',
      'import("fs")',
      'evaluate("1+1")',
      'parse("1")',
      'createUnit("x")',
      'factorial(1e9)',
      'zeros(1e9)',
      'range(1,1e9)',
      'sum(range(1,1e9))',
      '[1,2,3]',
      'a=1',
      'eval("1")',
      'Function("return 1")()',
      'x'.repeat(500),
      '2'.repeat(300) + '^2',
      '1e999999^1e999999',
    ]
    for (const e of evil) {
      const t = Date.now()
      expect(() => calculate(e, now)).not.toThrow()
      expect(calculate(e, now)).toBeNull()
      expect(Date.now() - t).toBeLessThan(500)
    }
  })
  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (s) => {
        calculate(s, now)
      }),
      { numRuns: 300 },
    )
  })
})

describe('dev utils', () => {
  it('hash/base64/jwt/ts/ulid/lorem/pw', () => {
    expect(hash('sha256', 'abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(b64dec(b64enc('héllo ✓'))).toBe('héllo ✓')
    expect(() => b64dec('***')).toThrow()
    const jwt =
      ['{"alg":"HS256"}', '{"sub":"1"}']
        .map((x) => Buffer.from(x).toString('base64url'))
        .join('.') + '.sig'
    expect(jwtDecode(jwt).payload).toEqual({ sub: '1' })
    expect(timestamp('1700000000', now).iso).toBe('2023-11-14T22:13:20.000Z')
    expect(timestamp('2023-11-14T22:13:20Z').epoch).toBe(1700000000)
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(ulid(1, new Uint8Array(10))).toBe('0000000001' + '0'.repeat(16))
    expect(lorem(5).split(' ')).toHaveLength(5)
    expect(password(24)).toHaveLength(24)
    expect(password(2)).toHaveLength(8)
  })
  it('regex tester is time-limited', () => {
    expect(regexTest('\\d+', 'g', 'a1 b22')).toEqual(['1', '22'])
    expect(() => regexTest('(a+)+$', '', 'a'.repeat(40) + '!')).toThrow()
    expect(() => regexTest('x', 'zz', 'x')).toThrow()
  })
})

describe('color', () => {
  it('parses and converts', () => {
    expect(parseColor('#ff8800')).toEqual({ r: 255, g: 136, b: 0 })
    expect(parseColor('#f80')).toEqual({ r: 255, g: 136, b: 0 })
    expect(parseColor('rgb(255, 136, 0)')).toEqual({ r: 255, g: 136, b: 0 })
    expect(parseColor('hsl(32, 100%, 50%)')).toEqual({ r: 255, g: 136, b: 0 })
    expect(parseColor('banana')).toBeNull()
    expect(parseColor('123')).toBeNull() // bare 3 digits are not a color
    expect(conversions({ r: 255, g: 136, b: 0 }).map((c) => c.value)).toEqual([
      '#ff8800',
      'rgb(255, 136, 0)',
      'hsl(32, 100%, 50%)',
    ])
  })
})

describe('quicklinks / system / processes / timers / emoji', () => {
  it('encodes queries and only allows http(s)', () => {
    expect(buildUrl('https://x.test/?q={query}', 'a b&c=d')).toBe('https://x.test/?q=a%20b%26c%3Dd')
    expect(buildUrl('javascript:alert({query})', 'x')).toBeNull()
    expect(buildUrl('file:///etc/{query}', 'passwd')).toBeNull()
  })
  it('system commands are argv arrays; destructive ones confirm', () => {
    for (const plat of ['darwin', 'win32', 'linux'] as const) {
      const cmds = systemCommands(plat, 'me')
      expect(cmds.length).toBeGreaterThan(3)
      for (const c of cmds) for (const s of c.steps) expect(Array.isArray(s.args)).toBe(true)
      for (const id of ['restart', 'shutdown'])
        expect(cmds.find((c) => c.id === id)?.confirm).toBe(true)
    }
  })
  it('process parsing and critical protection', () => {
    const procs = parsePs(
      ' 1 /sbin/launchd\n 501 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n 77 /usr/sbin/WindowServer',
    )
    expect(procs.map((p) => p.pid)).toEqual([1, 501, 77])
    expect(filterProcs(procs, 'chrome').map((p) => p.pid)).toEqual([501])
    expect(filterProcs(procs, 'launchd')).toEqual([])
    expect(filterProcs(procs, 'window')).toEqual([])
    expect(isCritical({ pid: 501, name: 'x' }, [501])).toBe(true)
    expect(parseTasklist('"chrome.exe","1234","Console","1","50,000 K"\r\n')).toEqual([
      { pid: 1234, name: 'chrome.exe' },
    ])
  })
  it('durations and timer store with fake clock', () => {
    expect(parseDuration('25m')).toBe(1_500_000)
    expect(parseDuration('1h30m')).toBe(5_400_000)
    expect(parseDuration('90s')).toBe(90_000)
    expect(parseDuration('10')).toBe(600_000)
    expect(parseDuration('abc')).toBeNull()
    expect(parseDuration('0m')).toBeNull()
    expect(formatRemaining(61_000)).toBe('1m 01s')
    let t = 0
    const jobs: { at: number; fn: () => void; id: number }[] = []
    const fired: string[] = []
    const store = new TimerStore({
      now: () => t,
      setTimeout: (fn, ms) => {
        jobs.push({ at: t + ms, fn, id: jobs.length })
        return jobs.length - 1
      },
      clearTimeout: (h) => {
        const j = jobs.find((x) => x.id === h)
        if (j) j.at = Infinity
      },
      onFire: (x) => fired.push(x.label),
    })
    const a = store.start(1000, 'tea')
    store.start(5000, 'pasta')
    store.cancel(a.id)
    t = 6000
    for (const j of jobs) if (j.at <= t) j.fn()
    expect(fired).toEqual(['pasta'])
    expect(store.list()).toEqual([])
  })
  it('emoji tones', () => {
    expect(withTone('👍', 1)).toBe('👍🏼')
  })
})

describe('provider integration', () => {
  const copied: string[] = []
  const effects: Effects = {
    copy: async (t) => void copied.push(t),
    openUrl: async (u) => void copied.push('open:' + u),
    notify: async () => {},
    readClipboard: async () => '{"a":1}',
    copyImage: async () => {},
    bindHotkey: async () => {},
  }
  const ctx: ProviderContext = { now: () => now.getTime(), effects }
  const engine = new SearchEngine({ ctx })
  const timers = new TimerStore({
    now: Date.now,
    setTimeout,
    clearTimeout: (h) => clearTimeout(h as never),
    onFire: () => {},
  })
  for (const p of [
    new CalculatorProvider(),
    new ColorProvider(),
    new DevProvider(),
    new SystemProvider(),
    new QuicklinkProvider(),
    new EmojiProvider(),
    new TimerProvider(timers),
  ])
    engine.register(p)
  const run = async (q: string) => {
    const out: import('@beacon/shared').ResultItem[] = []
    await engine.search(q, (b) => out.push(...b.items))
    return out
  }
  it('calculator result copies via activate', async () => {
    const [top] = await run('23*1.08')
    expect(top?.title).toBe('24.84')
    await engine.get('calc')!.activate!(top!.id, undefined, ctx)
    expect(copied.at(-1)).toBe('24.84')
  })
  it('triggers route to quicklinks / emoji / timer', async () => {
    const [g] = await run('g hello world')
    expect(g?.primary.payload).toEqual({ url: 'https://www.google.com/search?q=hello%20world' })
    await engine.get('quicklinks')!.activate!(g!.id, undefined, ctx)
    expect(copied.at(-1)).toBe('open:https://www.google.com/search?q=hello%20world')
    expect((await run('emoji fire')).some((i) => i.title.includes('🔥'))).toBe(true)
    const [t] = await run('timer 25m focus')
    expect(t?.title).toContain('25m')
    await engine.get('timer')!.activate!(t!.id, 'start', ctx)
    expect(timers.list()).toHaveLength(1)
    timers.cancel(timers.list()[0]!.id)
  })
  it('dev + color + system results', async () => {
    expect((await run('uuid'))[0]?.title).toMatch(/^[0-9a-f-]{36}$/)
    expect((await run('hash hello'))[0]?.title).toBe(hash('sha256', 'hello'))
    expect((await run('json'))[0]?.subtitle).toContain('clipboard')
    expect((await run('#ff8800'))[0]?.title).toBe('#ff8800')
    const lock = (await run('lock')).find((i) => i.providerId === 'system')
    expect(lock).toBeDefined()
  })
  it('arguments with shell metacharacters stay data', async () => {
    const [g] = await run('g a; rm -rf / && echo $(whoami)')
    expect(String((g!.primary.payload as { url: string }).url)).not.toMatch(/[;&$ ]/)
  })
  it('parseQuery sees provider triggers', () => {
    expect(parseQuery('timer 5m', engine.triggers()).trigger).toBe('timer ')
  })
})
