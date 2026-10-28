import type { ResultItem } from '@beacon/shared'
import type { SearchEngine } from './engine'

/** Messages renderer → search worker. */
export type ClientMessage =
  { type: 'query'; id: number; text: string } | { type: 'cancel'; id: number }

/** Messages search worker → renderer. */
export type ServerMessage =
  | { type: 'batch'; id: number; providerId: string; items: ResultItem[]; error?: string }
  | { type: 'done'; id: number }

/** Minimal MessagePort shape shared by Electron renderer ports and node:worker_threads. */
export interface PortLike {
  postMessage(msg: unknown): void
  onmessage: ((e: { data: unknown }) => void) | null
}

/**
 * Attach the search service to a port. A new query for the same port cancels the
 * previous one (cancel-on-next-keystroke). Returns a detach function.
 */
export function attachSearchService(port: PortLike, engine: SearchEngine): () => void {
  const running = new Map<number, AbortController>()
  port.onmessage = (e) => {
    const msg = e.data as ClientMessage
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'cancel') {
      running.get(msg.id)?.abort()
      running.delete(msg.id)
    } else if (msg.type === 'query' && typeof msg.text === 'string') {
      for (const c of running.values()) c.abort()
      running.clear()
      const ctl = new AbortController()
      running.set(msg.id, ctl)
      void engine
        .search(
          msg.text,
          (b) => {
            const out: ServerMessage = {
              type: 'batch',
              id: msg.id,
              providerId: b.providerId,
              items: b.items,
            }
            if (b.error !== undefined) out.error = b.error
            port.postMessage(out)
          },
          ctl.signal,
        )
        .finally(() => {
          if (!ctl.signal.aborted)
            port.postMessage({ type: 'done', id: msg.id } satisfies ServerMessage)
          running.delete(msg.id)
        })
    }
  }
  return () => {
    for (const c of running.values()) c.abort()
    port.onmessage = null
  }
}
