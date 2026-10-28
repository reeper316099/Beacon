import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { FuzzyIndex, compile, fuzzy, match, prepare, score } from '../src/index'

const s = (text: string, q: string) => fuzzy(text, q)?.score ?? null

describe('golden ranking', () => {
  const rank = (q: string, items: string[]) => {
    const idx = new FuzzyIndex(items.map((t) => [t, t] as [string, string]))
    return idx.search(q).map((r) => r.item)
  }

  it('prefers prefix over mid-word', () => {
    expect(rank('chr', ['Archer', 'Chrome', 'Orchard'])[0]).toBe('Chrome')
  })
  it('prefers word-boundary matches', () => {
    expect(rank('vsc', ['Visual Studio Code', 'Vascular Scan'])[0]).toBe('Visual Studio Code')
  })
  it('supports acronyms and camelCase', () => {
    expect(rank('ff', ['Firefox', 'Safari Offline'])[0]).toBe('Firefox')
    expect(rank('gc', ['getCwd', 'segment'])[0]).toBe('getCwd')
  })
  it('prefers contiguous over scattered', () => {
    expect(s('abc', 'abc')!).toBeGreaterThan(s('a-b-c', 'abc')!)
    expect(s('xabcx', 'abc')!).toBeGreaterThan(s('xaxbxcx', 'abc')!)
  })
  it('prefers shorter on otherwise equal matches', () => {
    expect(rank('term', ['Terminal Emulator Pro', 'Terminal'])[0]).toBe('Terminal')
  })
  it('requires all tokens', () => {
    expect(s('Visual Studio Code', 'vis code')).not.toBeNull()
    expect(s('Visual Studio', 'vis code')).toBeNull()
  })
  it('folds diacritics', () => {
    expect(s('Café Résumé', 'cafe resume')).not.toBeNull()
    expect(s('naïve', 'NAIVE')).not.toBeNull()
  })
  it('does not match non-subsequences', () => {
    expect(s('abc', 'cba')).toBeNull()
    expect(s('ab', 'abc')).toBeNull()
  })
  it('returns ascending positions that spell the query', () => {
    const m = fuzzy('Visual Studio Code', 'vsc')!
    expect(m.positions).toEqual([0, 7, 14])
  })
})

describe('properties', () => {
  const str = fc.string({ unit: 'binary', maxLength: 300 })

  it('never throws on weird input', () => {
    fc.assert(
      fc.property(str, str, (a, b) => {
        fuzzy(a, b)
        score(prepare(a), compile(b))
      }),
    )
    for (const x of [null, undefined, 42, {}, []] as unknown[]) {
      expect(() => fuzzy(x as string, x as string)).not.toThrow()
    }
  })

  it('is case-insensitive', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 8 }), (t, q) => {
        const a = fuzzy(t, q.toLowerCase())
        const b = fuzzy(t, q.toUpperCase())
        // toUpperCase may change length (e.g. ß); only compare when it does not.
        if (q.toUpperCase().length !== q.length) return
        expect(a?.score ?? null).toEqual(b?.score ?? null)
      }),
    )
  })

  it('empty query matches everything with score 0', () => {
    fc.assert(
      fc.property(str, (t) => {
        expect(fuzzy(t, '')).toEqual({ score: 0, positions: [] })
        expect(fuzzy(t, '   ')).toEqual({ score: 0, positions: [] })
      }),
    )
  })

  it('any substring of a string matches, with ascending valid positions', () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom(...'abcdefgh XYZ-_1'.split('')),
          minLength: 1,
          maxLength: 40,
        }),
        fc.nat(),
        fc.nat(),
        (t, a, b) => {
          const i = a % t.length
          const j = i + 1 + (b % (t.length - i))
          const sub = t.slice(i, j).replace(/\s/g, '')
          if (!sub) return
          const m = fuzzy(t, sub)
          expect(m).not.toBeNull()
          for (let k = 1; k < m!.positions.length; k++)
            expect(m!.positions[k]!).toBeGreaterThan(m!.positions[k - 1]!)
        },
      ),
    )
  })

  it('prefix match is never worse than the same text after a boundary', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom(...'abcdefg'.split('')), minLength: 2, maxLength: 20 }),
        fc.nat(),
        (t, n) => {
          const p = t.slice(0, 1 + (n % (t.length - 1)))
          const a = s(t, p)
          const b = s('z ' + t, p)
          expect(a).not.toBeNull()
          expect(b).not.toBeNull()
          expect(a!).toBeGreaterThanOrEqual(b!)
        },
      ),
    )
  })

  it('positions only cover characters equal (folded) to the query', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom(...'abcde'.split('')), minLength: 1, maxLength: 30 }),
        fc.string({ unit: fc.constantFrom(...'abcde'.split('')), minLength: 1, maxLength: 5 }),
        (t, q) => {
          const m = fuzzy(t, q)
          if (!m) return
          expect(m.positions.map((p) => t[p]).join('')).toBe(q)
        },
      ),
    )
  })

  it('search results are deterministic and stable for equal scores', () => {
    const items = Array.from({ length: 100 }, (_, i) => `item${i % 3}`)
    const idx = new FuzzyIndex(items.map((t, i) => [t, i] as [string, number]))
    const a = idx.search('item', 100).map((r) => r.item)
    const b = idx.search('item', 100).map((r) => r.item)
    expect(a).toEqual(b)
    const eq = idx.search('item0', 100).map((r) => r.item)
    expect(eq).toEqual([...eq].sort((x, y) => x - y))
  })
})

describe('match()', () => {
  it('agrees with score()', () => {
    const p = prepare('Visual Studio Code')
    const q = compile('vsc')
    expect(match(p, q)!.score).toBe(score(p, q))
  })
})
