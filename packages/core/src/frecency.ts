export interface FrecencyEntry {
  /** Decayed selection count as of `ts`. */
  v: number
  ts: number
}

export type FrecencyData = Record<string, Record<string, FrecencyEntry>>

export interface FrecencyOptions {
  /** Half-life in ms. Default 7 days. */
  halfLifeMs?: number
  now?: () => number
  /** Max remembered query-prefixes per item. */
  maxQueriesPerItem?: number
}

const DAY = 86_400_000

/**
 * Per-(query, item) selection history with exponential decay.
 * Each selection adds 1; value halves every half-life. A lookup for the typed
 * query sums entries recorded under any query that starts with it, so selecting
 * "Firefox" after typing "fire" also helps when you've only typed "fi".
 */
export class Frecency {
  private data: FrecencyData
  private halfLifeMs: number
  private now: () => number
  private maxQ: number

  constructor(opts: FrecencyOptions = {}, data: FrecencyData = {}) {
    this.halfLifeMs = opts.halfLifeMs ?? 7 * DAY
    this.now = opts.now ?? Date.now
    this.maxQ = opts.maxQueriesPerItem ?? 16
    this.data = data
  }

  setHalfLife(ms: number): void {
    if (ms > 0) this.halfLifeMs = ms
  }

  private decay(e: FrecencyEntry, at: number): number {
    const dt = Math.max(0, at - e.ts)
    return e.v * Math.pow(2, -dt / this.halfLifeMs)
  }

  record(query: string, key: string): void {
    const q = query.trim().toLowerCase()
    const at = this.now()
    const item = (this.data[key] ??= {})
    const e = item[q]
    item[q] = { v: (e ? this.decay(e, at) : 0) + 1, ts: at }
    const qs = Object.keys(item)
    if (qs.length > this.maxQ) {
      let worst = qs[0] as string
      let worstV = Infinity
      for (const k of qs) {
        const v = this.decay(item[k] as FrecencyEntry, at)
        if (v < worstV) {
          worstV = v
          worst = k
        }
      }
      delete item[worst]
    }
  }

  /** Decayed score; 0 when never selected. */
  score(query: string, key: string): number {
    const item = this.data[key]
    if (!item) return 0
    const q = query.trim().toLowerCase()
    const at = this.now()
    let sum = 0
    for (const [rq, e] of Object.entries(item)) if (rq.startsWith(q)) sum += this.decay(e, at)
    return sum
  }

  /** Multiplicative ranking boost, >= 1. */
  boost(query: string, key: string): number {
    return 1 + Math.log1p(this.score(query, key))
  }

  forget(key: string): void {
    delete this.data[key]
  }

  reset(): void {
    this.data = {}
  }

  /** Items with the highest frecency for the empty-query state. */
  top(limit: number): { key: string; score: number }[] {
    const out: { key: string; score: number }[] = []
    for (const key of Object.keys(this.data)) out.push({ key, score: this.score('', key) })
    out.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1))
    return out.slice(0, limit)
  }

  serialize(): FrecencyData {
    return structuredClone(this.data)
  }
}
