import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { Provider, ResultItem } from '@beacon/shared'
import {
  Frecency,
  NameIndexProvider,
  SearchEngine,
  StableList,
  attachSearchService,
  parseQuery,
  tokenize,
  type ServerMessage,
} from '../src/index'

const act = { id: 'open', title: 'Open', kind: 'open' as const, payload: null }
const item = (id: string, score: number, providerId = 'p'): ResultItem => ({
  id,
  providerId,
  title: id,
  kind: 'x',
  score,
  primary: act,
})

describe('parseQuery', () => {
  it('plain text', () => {
    const q = parseQuery('hello world')
    expect(q.text).toBe('hello world')
    expect(q.terms).toEqual(['hello', 'world'])
    expect(q.trigger).toBeUndefined()
  })
  it('trigger needs its trailing space', () => {
    expect(parseQuery('cb', ['cb ']).trigger).toBeUndefined()
    expect(parseQuery('cb foo', ['cb ']).trigger).toBe('cb ')
    expect(parseQuery('CB foo', ['cb ']).text).toBe('foo')
  })
  it('longest trigger wins', () => {
    expect(parseQuery('> x', ['>', '> ']).trigger).toBe('> ')
  })
  it('filters and args', () => {
    const q = parseQuery('ssh prod "weekly run" ext:pdf in:Documents', ['ssh '])
    expect(q.filters).toEqual({ ext: 'pdf', in: 'Documents' })
    expect(q.command).toBe('prod')
    expect(q.args).toEqual(['weekly run'])
  })
  it('unknown key:value stays text', () => {
    expect(parseQuery('foo:bar').terms).toEqual(['foo:bar'])
    expect(parseQuery('ext:').terms).toEqual(['ext:'])
  })
  it('tokenize handles quotes', () => {
    expect(tokenize(`a "b c" 'd e' ""`)).toEqual(['a', 'b c', 'd e', ''])
  })
  it('never throws and round-trips raw', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        const q = parseQuery(s, ['cb ', '> '])
        expect(q.raw).toBe(s)
      }),
    )
  })
})

describe('Frecency', () => {
  const DAY = 86_400_000
  it('decays by half each half-life', () => {
    let t = 0
    const f = new Frecency({ halfLifeMs: DAY, now: () => t })
    f.record('fi', 'ff')
    expect(f.score('fi', 'ff')).toBeCloseTo(1)
    t = DAY
    expect(f.score('fi', 'ff')).toBeCloseTo(0.5)
    t = 3 * DAY
    expect(f.score('fi', 'ff')).toBeCloseTo(0.125)
  })
  it('query-prefix matching', () => {
    const f = new Frecency({ now: () => 0 })
    f.record('fire', 'ff')
    expect(f.score('fi', 'ff')).toBeGreaterThan(0)
    expect(f.score('', 'ff')).toBeGreaterThan(0)
    expect(f.score('fz', 'ff')).toBe(0)
  })
  it('boost monotonic in selections; forget/reset clear', () => {
    const f = new Frecency({ now: () => 0 })
    f.record('a', 'x')
    const b1 = f.boost('a', 'x')
    f.record('a', 'x')
    expect(f.boost('a', 'x')).toBeGreaterThan(b1)
    f.forget('x')
    expect(f.boost('a', 'x')).toBe(1)
    f.record('a', 'y')
    f.reset()
    expect(f.top(5)).toEqual([])
  })
  it('score never negative / never increases with time', () => {
    fc.assert(
      fc.property(fc.nat(10), fc.nat(1e9), fc.nat(1e9), (n, d1, d2) => {
        let t = 0
        const f = new Frecency({ now: () => t })
        for (let i = 0; i < n + 1; i++) f.record('q', 'k')
        t = Math.min(d1, d2)
        const a = f.score('q', 'k')
        t = Math.max(d1, d2)
        const b = f.score('q', 'k')
        expect(a).toBeGreaterThanOrEqual(b)
        expect(b).toBeGreaterThanOrEqual(0)
      }),
    )
  })
  it('caps remembered queries per item', () => {
    const f = new Frecency({ now: () => 0, maxQueriesPerItem: 3 })
    for (const q of ['a', 'b', 'c', 'd', 'e']) f.record(q, 'k')
    expect(Object.keys(f.serialize()['k']!).length).toBe(3)
  })
})

describe('StableList', () => {
  it('does not move rows at or above the selection', () => {
    const l = new StableList()
    l.merge([item('a', 10), item('b', 5)], -1)
    expect(l.items.map((i) => i.id)).toEqual(['a', 'b'])
    l.merge([item('late', 100)], 0) // selected row 0 = 'a'
    expect(l.items.map((i) => i.id)).toEqual(['a', 'late', 'b'])
  })
  it('dedupes', () => {
    const l = new StableList()
    l.merge([item('a', 1)], -1)
    l.merge([item('a', 9)], -1)
    expect(l.items).toHaveLength(1)
  })
})

describe('SearchEngine', () => {
  const mk = (
    id: string,
    delay: number,
    items: ResultItem[],
    mode: Provider['mode'] = 'global',
  ): Provider => ({
    id,
    name: id,
    mode,
    query: (_q, _c, signal) =>
      new Promise((res) => {
        const t = setTimeout(() => res(items), delay)
        signal.addEventListener('abort', () => clearTimeout(t))
      }),
  })

  it('fast providers are emitted before slow ones', async () => {
    const e = new SearchEngine({ timeoutMs: 500 })
    e.register(mk('slow', 60, [item('s', 1, 'slow')]))
    e.register(mk('fast', 0, [item('f', 1, 'fast')]))
    const order: string[] = []
    await e.search('x', (b) => order.push(b.providerId))
    expect(order).toEqual(['fast', 'slow'])
  })

  it('times out slow providers without blocking', async () => {
    const e = new SearchEngine({ timeoutMs: 20 })
    e.register(mk('hang', 10_000, [item('h', 1, 'hang')]))
    const got: ResultItem[] = []
    const t = Date.now()
    await e.search('x', (b) => got.push(...b.items))
    expect(Date.now() - t).toBeLessThan(500)
    expect(got).toEqual([])
  })

  it('abort suppresses batches', async () => {
    const e = new SearchEngine({ timeoutMs: 500 })
    e.register(mk('a', 30, [item('a', 1, 'a')]))
    const ctl = new AbortController()
    const got: string[] = []
    const p = e.search('x', (b) => got.push(b.providerId), ctl.signal)
    ctl.abort()
    await p
    expect(got).toEqual([])
  })

  it('trigger selects a prefix provider; sensitive hidden in global list', async () => {
    const e = new SearchEngine()
    const clip: Provider = {
      ...mk('clip', 0, [{ ...item('secret', 1, 'clip'), sensitive: true }], 'prefix-only'),
      triggers: ['cb '],
    }
    const other = mk('other', 0, [
      { ...item('s2', 1, 'other'), sensitive: true },
      item('ok', 1, 'other'),
    ])
    e.register(clip)
    e.register(other)
    const globalIds: string[] = []
    await e.search('hi', (b) => globalIds.push(...b.items.map((i) => i.id)))
    expect(globalIds).toEqual(['ok'])
    const trig: string[] = []
    await e.search('cb hi', (b) => trig.push(...b.items.map((i) => i.id)))
    expect(trig).toEqual(['secret'])
  })

  it('provider errors do not break others', async () => {
    const e = new SearchEngine()
    e.register({
      id: 'bad',
      name: 'bad',
      mode: 'global',
      query: async () => {
        throw new Error('boom')
      },
    })
    e.register(mk('good', 0, [item('g', 1, 'good')]))
    const seen: Record<string, string | undefined> = {}
    await e.search('x', (b) => (seen[b.providerId] = b.error))
    expect(seen['bad']).toBe('boom')
    expect('good' in seen).toBe(true)
  })

  it('frecency boosts ranking', async () => {
    const f = new Frecency({ now: () => 0 })
    f.record('a', 'b')
    const e = new SearchEngine({ frecency: f })
    e.register(mk('p', 0, [item('a', 10), item('b', 10)]))
    let ids: string[] = []
    await e.search('a', (b) => (ids = b.items.map((i) => i.id)))
    expect(ids[0]).toBe('b')
  })
})

describe('NameIndexProvider + port protocol', () => {
  it('serves queries over a MessagePort and cancels the previous query', async () => {
    const p = new NameIndexProvider('apps', 'Apps')
    p.set(
      ['Firefox', 'Safari', 'Terminal'].map((t) => ({
        id: t,
        title: t,
        kind: 'app',
        primary: act,
      })),
    )
    const engine = new SearchEngine()
    engine.register(p)
    const { port1, port2 } = new MessageChannel()
    attachSearchService(port2 as never, engine)
    const msgs: ServerMessage[] = []
    const done = new Promise<void>((res) => {
      port1.onmessage = (e) => {
        const m = e.data as ServerMessage
        msgs.push(m)
        if (m.type === 'done' && m.id === 2) res()
      }
    })
    port1.postMessage({ type: 'query', id: 1, text: 'fir' })
    port1.postMessage({ type: 'query', id: 2, text: 'fire' })
    await done
    port1.close()
    port2.close()
    const batch = msgs.find((m) => m.type === 'batch' && m.id === 2)
    expect(batch && batch.type === 'batch' && batch.items[0]?.title).toBe('Firefox')
  })
})
