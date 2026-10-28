import type { ParsedQuery, Provider, ProviderContext, ResultItem } from '@beacon/shared'
import { parseQuery } from './parser'
import { rank } from './ranking'
import type { Frecency } from './frecency'

export interface EngineOptions {
  /** Per-provider timeout in ms. Default 250. */
  timeoutMs?: number
  frecency?: Frecency
  weights?: Record<string, number>
  ctx?: ProviderContext
  /** Provider ids the user has disabled. */
  disabled?: Set<string>
  /** Include `sensitive` results in the default (non-trigger) list. */
  showSensitiveGlobally?: boolean
}

export interface Batch {
  providerId: string
  items: ResultItem[]
  /** True when this provider has finished (success, timeout or error). */
  done: boolean
  error?: string
}

export class SearchEngine {
  private providers = new Map<string, Provider>()
  readonly opts: EngineOptions

  constructor(opts: EngineOptions = {}) {
    this.opts = { timeoutMs: 250, ...opts }
  }

  register(p: Provider): void {
    this.providers.set(p.id, p)
  }

  unregister(id: string): void {
    this.providers.delete(id)
  }

  get(id: string): Provider | undefined {
    return this.providers.get(id)
  }

  triggers(): string[] {
    return [...this.providers.values()].flatMap((p) => p.triggers ?? [])
  }

  ctx(): ProviderContext {
    return this.opts.ctx ?? { now: Date.now }
  }

  private active(): Provider[] {
    return [...this.providers.values()].filter((p) => !this.opts.disabled?.has(p.id))
  }

  /** Which providers answer this parsed query. */
  select(q: ParsedQuery): Provider[] {
    const active = this.active()
    if (q.trigger) {
      const t = q.trigger.toLowerCase()
      return active.filter((p) => p.triggers?.some((x) => x.toLowerCase() === t))
    }
    return active.filter((p) => p.mode === 'global')
  }

  /**
   * Run a query. Providers run concurrently; each finished provider's batch is
   * emitted immediately so fast providers never wait for slow ones.
   */
  async search(
    raw: string,
    onBatch: (b: Batch) => void,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    const q = parseQuery(raw, this.triggers())
    const chosen = this.select(q)
    const ctx = this.ctx()
    const timeoutMs = this.opts.timeoutMs ?? 250

    await Promise.all(
      chosen.map(async (p) => {
        const local = new AbortController()
        const onAbort = () => local.abort()
        signal.addEventListener('abort', onAbort, { once: true })
        const timer = setTimeout(() => local.abort(), timeoutMs)
        let items: ResultItem[] = []
        let error: string | undefined
        try {
          items = await collect(p, q, ctx, local.signal)
        } catch (e) {
          if (!local.signal.aborted) error = e instanceof Error ? e.message : String(e)
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
        }
        if (signal.aborted) return
        if (!q.trigger && !this.opts.showSensitiveGlobally)
          items = items.filter((i) => !i.sensitive)
        const ranked = rank(items, {
          query: q.text,
          weights: { [p.id]: p.weight ?? 1, ...this.opts.weights },
          ...(this.opts.frecency ? { frecency: this.opts.frecency } : {}),
        })
        const batch: Batch = { providerId: p.id, items: ranked, done: true }
        if (error !== undefined) batch.error = error
        onBatch(batch)
      }),
    )
  }
}

async function collect(
  p: Provider,
  q: ParsedQuery,
  ctx: ProviderContext,
  signal: AbortSignal,
): Promise<ResultItem[]> {
  const out = p.query(q, ctx, signal)
  if (Symbol.asyncIterator in Object(out)) {
    const items: ResultItem[] = []
    const it = (out as AsyncIterable<ResultItem>)[Symbol.asyncIterator]()
    const aborted = new Promise<'abort'>((res) =>
      signal.addEventListener('abort', () => res('abort'), { once: true }),
    )
    for (;;) {
      const r = await Promise.race([it.next(), aborted])
      if (r === 'abort' || r.done) break
      items.push(r.value)
    }
    return items
  }
  // Promise-returning providers: stop waiting on timeout/abort (keep what we have: nothing).
  const aborted = new Promise<ResultItem[]>((res) =>
    signal.addEventListener('abort', () => res([]), { once: true }),
  )
  return Promise.race([out as Promise<ResultItem[]>, aborted])
}
