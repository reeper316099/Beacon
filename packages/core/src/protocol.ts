import type { ResultItem } from '@beacon/shared'
import type { SearchEngine } from './engine'

/** Messages renderer → search worker. */
export type ClientMessage =
  | { type: 'query'; id: number; text: string }
  | { type: 'cancel'; id: number }
  | { type: 'pin'; id: number; item: ResultItem }
  | {
      type: 'script-run'
      runId: string
      scriptId: string
      args?: Record<string, string>
      trustHash?: string
      confirmed?: boolean
      selection?: string
    }
  | { type: 'script-cancel'; runId: string }
  | { type: 'forget'; id: number; providerId: string; itemId: string; frecencyKey?: string }
  | {
      type: 'activate'
      id: number
      providerId: string
      itemId: string
      actionId?: string
      /** Query text at selection time, for frecency. */
      query: string
      frecencyKey?: string
    }

/** Messages search worker → renderer. */
export type ServerMessage =
  | { type: 'batch'; id: number; providerId: string; items: ResultItem[]; error?: string }
  | { type: 'done'; id: number }
  | { type: 'activated'; id: number; ok: boolean; error?: string }
  | { type: 'pinned'; id: number; pinned: boolean }
  | { type: 'script-event'; runId: string; event: Record<string, unknown> }
  | { type: 'forgotten'; id: number }

/** Minimal MessagePort shape shared by Electron renderer ports and node:worker_threads. */
export interface PortLike {
  postMessage(msg: unknown): void
  onmessage: ((e: { data: unknown }) => void) | null
}

/**
 * Attach the search service to a port. A new query for the same port cancels the
 * previous one (cancel-on-next-keystroke). Returns a detach function.
 */
export interface ServiceHooks {
  /** Toggle a pin; resolves to the new pinned state. */
  pin?(item: ResultItem): Promise<boolean>
  /** Script runs (inline output panel). `post` sends events back to the same port. */
  scriptRun?(
    msg: Extract<ClientMessage, { type: 'script-run' }>,
    post: (event: Record<string, unknown>) => void,
  ): void
  scriptCancel?(runId: string): void
}

export function attachSearchService(
  port: PortLike,
  engine: SearchEngine,
  hooks: ServiceHooks = {},
): () => void {
  const running = new Map<number, AbortController>()
  let last: { id: number; text: string } | undefined
  const runQuery = (id: number, text: string): void => {
    last = { id, text }
    for (const c of running.values()) c.abort()
    running.clear()
    const ctl = new AbortController()
    running.set(id, ctl)
    void engine
      .search(
        text,
        (b) => {
          const out: ServerMessage = { type: 'batch', id, providerId: b.providerId, items: b.items }
          if (b.error !== undefined) out.error = b.error
          port.postMessage(out)
        },
        ctl.signal,
      )
      .finally(() => {
        if (!ctl.signal.aborted) port.postMessage({ type: 'done', id } satisfies ServerMessage)
        // A re-run reuses the id: only clear our own entry, never the newer run's.
        if (running.get(id) === ctl) running.delete(id)
      })
  }
  port.onmessage = (e) => {
    const msg = e.data as ClientMessage
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'script-run') {
      hooks.scriptRun?.(msg, (event) =>
        port.postMessage({ type: 'script-event', runId: msg.runId, event } satisfies ServerMessage),
      )
    } else if (msg.type === 'script-cancel') {
      hooks.scriptCancel?.(msg.runId)
    } else if (msg.type === 'pin') {
      void (hooks.pin?.(msg.item) ?? Promise.resolve(false)).then((pinned) =>
        port.postMessage({ type: 'pinned', id: msg.id, pinned } satisfies ServerMessage),
      )
    } else if (msg.type === 'forget') {
      engine.opts.frecency?.forget(msg.frecencyKey ?? msg.itemId)
      void Promise.resolve(engine.get(msg.providerId)?.forget?.(msg.itemId)).finally(() =>
        port.postMessage({ type: 'forgotten', id: msg.id } satisfies ServerMessage),
      )
    } else if (msg.type === 'activate') {
      const p = engine.get(msg.providerId)
      const reply = (ok: boolean, error?: string) =>
        port.postMessage({ type: 'activated', id: msg.id, ok, ...(error ? { error } : {}) })
      if (!p?.activate) return reply(false, 'unsupported')
      p.activate(msg.itemId, msg.actionId, engine.ctx()).then(
        () => {
          engine.opts.frecency?.record(msg.query, msg.frecencyKey ?? msg.itemId)
          reply(true)
        },
        (e) => reply(false, e instanceof Error ? e.message : String(e)),
      )
    } else if (msg.type === 'cancel') {
      running.get(msg.id)?.abort()
      running.delete(msg.id)
    } else if (msg.type === 'query' && typeof msg.text === 'string') {
      runQuery(msg.id, msg.text)
    }
  }
  // The index (or another provider's data) changed under a query that already ran: run it again
  // under the same id so the late results stream in like any slow provider's would.
  const unsubscribe = engine.onInvalidate(() => {
    if (last) runQuery(last.id, last.text)
  })
  return () => {
    unsubscribe()
    for (const c of running.values()) c.abort()
    port.onmessage = null
  }
}
