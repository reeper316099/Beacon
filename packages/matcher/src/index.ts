/**
 * Fuzzy matcher: a small Smith-Waterman-style scorer in the spirit of fzf.
 *
 * - Case-insensitive and diacritic-insensitive.
 * - Bonuses for word boundaries, camelCase humps, consecutive runs and prefix hits.
 * - Multi-token queries: every whitespace-separated token must match (AND).
 * - Never throws; inputs are length-capped.
 */

const MAX_TEXT = 256
const MAX_PATTERN = 64
const NEG = -1_000_000

const SCORE_MATCH = 16
const GAP_START = -3
const GAP_EXT = -1
const BONUS_BOUNDARY = 20
const BONUS_CAMEL = 16
const BONUS_DIGIT = 8
const BONUS_CONSECUTIVE = 6
const FIRST_CHAR_MULT = 2
const BONUS_EXACT = 40
const BONUS_PREFIX = 20

/** Fold one UTF-16 unit: strip diacritics and lowercase, keeping length 1:1. */
function foldUnit(c: string): string {
  const code = c.charCodeAt(0)
  if (code < 128) return c.toLowerCase()
  const d = c.normalize('NFD')
  const base = d.charAt(0)
  return base.toLowerCase().charAt(0) || c
}

export function fold(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) out += foldUnit(s[i] as string)
  return out
}

export interface Prepared {
  readonly raw: string
  readonly folded: string
  readonly bonus: Int8Array
}

type CharClass = 0 | 1 | 2 | 3 // other/space, lower, upper, digit

function classOf(c: string): CharClass {
  if (c >= 'a' && c <= 'z') return 1
  if (c >= 'A' && c <= 'Z') return 2
  if (c >= '0' && c <= '9') return 3
  if (c.charCodeAt(0) > 127) {
    if (c.toLowerCase() !== c.toUpperCase()) return c === c.toLowerCase() ? 1 : 2
    return 1
  }
  return 0
}

/** Precompute the folded haystack and per-position boundary bonuses. */
export function prepare(text: string): Prepared {
  const raw = typeof text === 'string' ? text.slice(0, MAX_TEXT) : ''
  const folded = fold(raw)
  const bonus = new Int8Array(raw.length)
  let prev: CharClass = 0
  for (let i = 0; i < raw.length; i++) {
    const cls = classOf(raw[i] as string)
    let b = 0
    if (cls !== 0) {
      if (prev === 0) b = BONUS_BOUNDARY
      else if (prev === 1 && cls === 2) b = BONUS_CAMEL
      else if (prev !== 3 && cls === 3) b = BONUS_DIGIT
    }
    bonus[i] = b
    prev = cls
  }
  return { raw, folded, bonus }
}

export interface Match {
  score: number
  /** Matched indices into the (length-capped) raw string, ascending. */
  positions: number[]
}

/** Compiled query: folded tokens. */
export interface Compiled {
  tokens: string[]
}

export function compile(query: string): Compiled {
  const q = typeof query === 'string' ? query : ''
  const tokens = fold(q.slice(0, 256))
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.slice(0, MAX_PATTERN))
  return { tokens }
}

// Reusable scratch buffers (the matcher is single-threaded per worker).
let prevM = new Int32Array(MAX_TEXT)
let curM = new Int32Array(MAX_TEXT)
const back = new Int16Array(MAX_PATTERN * MAX_TEXT)
const slotOf = new Int8Array(65536).fill(-1) // char code -> distinct pattern-char slot
const slotChar = new Uint16Array(MAX_PATTERN)
const pSlot = new Uint8Array(MAX_PATTERN)
const occN = new Int16Array(MAX_PATTERN)
const occ = new Int16Array(MAX_PATTERN * MAX_TEXT)

/** Fast path for one-character tokens: no DP needed. */
function scoreSingle(pc: number, prep: Prepared): { score: number; positions: number[] } | null {
  const t = prep.folded
  const n = t.length
  let best = NEG
  let bestJ = -1
  for (let j = 0; j < n; j++) {
    if (t.charCodeAt(j) !== pc) continue
    const start = j === 0 ? BONUS_BOUNDARY : (prep.bonus[j] as number)
    let v = SCORE_MATCH + start * FIRST_CHAR_MULT
    if (j > 0) v += GAP_START + GAP_EXT * Math.min(j - 1, 8)
    if (v > best) {
      best = v
      bestJ = j
    }
  }
  if (bestJ < 0) return null
  let score = best
  if (n === 1) score += BONUS_EXACT
  else if (bestJ === 0) score += BONUS_PREFIX
  score -= Math.min(n - 1, 40) >> 2
  return { score, positions: [bestJ] }
}

/**
 * Scores one token. The DP only visits positions where the pattern character occurs
 * (sparse), and the gap penalty is linear in distance so the best predecessor is a
 * running prefix-max of (M[k] - GAP_EXT*k): exact, O(n + occurrences).
 */
function scoreToken(
  p: string,
  prep: Prepared,
  wantPositions: boolean,
): { score: number; positions: number[] } | null {
  const t = prep.folded
  const n = t.length
  const m = p.length
  if (m === 0) return { score: 0, positions: [] }
  if (m > n) return null
  if (m === 1) return scoreSingle(p.charCodeAt(0), prep)
  const bonus = prep.bonus

  let ns = 0
  try {
    for (let i = 0; i < m; i++) {
      const c = p.charCodeAt(i)
      let s = slotOf[c] as number
      if (s < 0) {
        s = ns++
        slotOf[c] = s
        slotChar[s] = c
        occN[s] = 0
      }
      pSlot[i] = s
    }
    for (let j = 0; j < n; j++) {
      const s = slotOf[t.charCodeAt(j)] as number
      if (s >= 0) {
        const c = occN[s] as number
        occ[s * MAX_TEXT + c] = j
        occN[s] = c + 1
      }
    }

    for (let i = 0; i < m; i++) {
      const s = pSlot[i] as number
      const cnt = occN[s] as number
      if (cnt === 0) return null
      const base = s * MAX_TEXT
      if (i === 0) {
        for (let a = 0; a < cnt; a++) {
          const j = occ[base + a] as number
          const start = j === 0 ? BONUS_BOUNDARY : (bonus[j] as number)
          let mv = SCORE_MATCH + start * FIRST_CHAR_MULT
          if (j > 0) mv += GAP_START + GAP_EXT * Math.min(j - 1, 8)
          curM[j] = mv
          if (wantPositions) back[j] = -1
        }
      } else {
        const ps = pSlot[i - 1] as number
        const pbase = ps * MAX_TEXT
        const pcnt = occN[ps] as number
        const prevChar = slotChar[ps] as number
        let pa = 0
        let bestH = NEG
        let bestK = -1
        for (let a = 0; a < cnt; a++) {
          const j = occ[base + a] as number
          while (pa < pcnt && (occ[pbase + pa] as number) < j) {
            const k = occ[pbase + pa] as number
            const mk = prevM[k] as number
            if (mk > NEG) {
              const h = mk - GAP_EXT * k
              if (h >= bestH) {
                bestH = h
                bestK = k
              }
            }
            pa++
          }
          const start = j === 0 ? BONUS_BOUNDARY : (bonus[j] as number)
          let mv = NEG
          let from = -1
          if (j > 0 && t.charCodeAt(j - 1) === prevChar) {
            const d = prevM[j - 1] as number
            if (d > NEG) {
              mv = d + SCORE_MATCH + (start > BONUS_CONSECUTIVE ? start : BONUS_CONSECUTIVE)
              from = j - 1
            }
          }
          if (bestK >= 0) {
            const v = bestH + GAP_START + GAP_EXT * (j - 1) + SCORE_MATCH + start
            if (v > mv) {
              mv = v
              from = bestK
            }
          }
          curM[j] = mv
          if (wantPositions) back[i * MAX_TEXT + j] = from
        }
      }
      ;[prevM, curM] = [curM, prevM]
    }

    const ls = pSlot[m - 1] as number
    const lcnt = occN[ls] as number
    let best = NEG
    let bestJ = -1
    for (let a = 0; a < lcnt; a++) {
      const j = occ[ls * MAX_TEXT + a] as number
      const v = prevM[j] as number
      if (v > best) {
        best = v
        bestJ = j
      }
    }
    if (bestJ < 0) return null

    let score = best
    // Whole-string and prefix bonuses; shorter haystacks edge out longer ones.
    if (m === n) score += BONUS_EXACT
    else if (t.startsWith(p)) score += BONUS_PREFIX
    score -= Math.min(n - m, 40) >> 2

    const positions: number[] = []
    if (wantPositions) {
      let j = bestJ
      for (let i = m - 1; i >= 0 && j >= 0; i--) {
        positions.push(j)
        j = back[i * MAX_TEXT + j] as number
      }
      positions.reverse()
    }
    return { score, positions }
  } finally {
    for (let s = 0; s < ns; s++) slotOf[slotChar[s] as number] = -1
  }
}

/** Score a prepared haystack against a compiled query. `null` = no match. */
export function score(prep: Prepared, q: Compiled): number | null {
  try {
    if (q.tokens.length === 0) return 0
    let total = 0
    for (const tok of q.tokens) {
      const r = scoreToken(tok, prep, false)
      if (!r) return null
      total += r.score
    }
    return total
  } catch {
    return null
  }
}

/** Like `score` but also returns matched positions (for highlighting). */
export function match(prep: Prepared, q: Compiled): Match | null {
  try {
    if (q.tokens.length === 0) return { score: 0, positions: [] }
    let total = 0
    const set = new Set<number>()
    for (const tok of q.tokens) {
      const r = scoreToken(tok, prep, true)
      if (!r) return null
      total += r.score
      for (const p of r.positions) set.add(p)
    }
    return { score: total, positions: [...set].sort((a, b) => a - b) }
  } catch {
    return null
  }
}

/** Convenience: one-shot match of a string. */
export function fuzzy(text: string, query: string): Match | null {
  return match(prepare(text), compile(query))
}

export interface Ranked<T> {
  item: T
  score: number
  index: number
}

/**
 * Index of prepared strings with top-k search. Equal scores keep insertion order
 * (stable, deterministic).
 */
export class FuzzyIndex<T> {
  private prepared: Prepared[] = []
  private items: T[] = []

  constructor(entries: Iterable<[string, T]> = []) {
    for (const [text, item] of entries) this.add(text, item)
  }

  get size(): number {
    return this.items.length
  }

  add(text: string, item: T): void {
    this.prepared.push(prepare(text))
    this.items.push(item)
  }

  clear(): void {
    this.prepared = []
    this.items = []
  }

  search(query: string, limit = 50): Ranked<T>[] {
    const q = compile(query)
    const top: Ranked<T>[] = []
    const better = (a: Ranked<T>, b: Ranked<T>) =>
      a.score > b.score || (a.score === b.score && a.index < b.index)
    for (let i = 0; i < this.prepared.length; i++) {
      const s = score(this.prepared[i] as Prepared, q)
      if (s === null) continue
      if (top.length >= limit && s <= (top[top.length - 1] as Ranked<T>).score) continue
      const entry: Ranked<T> = { item: this.items[i] as T, score: s, index: i }
      let k = top.length
      while (k > 0 && better(entry, top[k - 1] as Ranked<T>)) k--
      top.splice(k, 0, entry)
      if (top.length > limit) top.pop()
    }
    return top
  }
}
