import { z } from 'zod'
import type { Action, ResultItem } from '@beacon/shared'
import { Grants, type Op } from './permissions'
import type { Manifest } from './manifest'

/** The few things an extension may ask the host to do. Each is checked against granted permissions first. */
export interface ExtPlatform {
  clipboardRead(): Promise<string>
  clipboardWrite(text: string): Promise<void>
  notify(extName: string, title: string, body?: string): Promise<void>
  fsRead(path: string): Promise<string>
  fsWrite(path: string, data: string): Promise<void>
  exec(
    file: string,
    args: string[],
  ): Promise<{ code: number | null; stdout: string; stderr: string }>
  fetch(
    url: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; body: string }>
  storageGet(extId: string, key: string): Promise<unknown>
  storageSet(extId: string, key: string, value: unknown): Promise<void>
  realpath(path: string): Promise<string>
}

export interface ExtProc {
  send(msg: unknown): void
  onMessage(cb: (msg: unknown) => void): void
  onExit(cb: (code: number | null) => void): void
  kill(): void
}

export interface LoadedExtension {
  manifest: Manifest
  code: string
}

type Timer = { set(fn: () => void, ms: number): unknown; clear(h: unknown): void }
const realTimer: Timer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
}

export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 30_000]
export const MAX_CRASHES = 5
export const CRASH_WINDOW_MS = 10 * 60_000

type State = 'running' | 'restarting' | 'crashed' | 'stopped'

interface Running {
  ext: LoadedExtension
  grants: Grants
  proc?: ExtProc
  state: State
  crashes: number[]
  pending: Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: unknown }>
  restartTimer?: unknown
}

// ---- validation of what an extension returns ----
const ActionIn = z.object({
  id: z.string().min(1).max(60),
  title: z.string().min(1).max(120),
  kind: z.enum(['copy', 'url', 'open', 'reveal', 'run', 'custom']),
  payload: z.unknown().optional(),
})
const ItemIn = z.object({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(300),
  subtitle: z.string().max(300).optional(),
  icon: z.string().max(8).optional(),
  score: z.number().finite().min(0).max(1000).optional(),
  primary: ActionIn,
  actions: z.array(ActionIn).max(8).optional(),
})

/** Turn untrusted extension output into safe ResultItems: scheme checks, forced confirms, capped sizes. */
export function sanitizeItems(extId: string, raw: unknown): ResultItem[] {
  if (!Array.isArray(raw)) return []
  // Validate item by item: one bad item must not hide the good ones.
  const parsed = {
    data: raw.slice(0, 50).flatMap((x) => {
      const r = ItemIn.safeParse(x)
      return r.success ? [r.data] : []
    }),
  }
  const fix = (a: z.infer<typeof ActionIn>): Action | null => {
    const p = (a.payload ?? {}) as Record<string, unknown>
    switch (a.kind) {
      case 'copy':
        return typeof p['text'] === 'string' && p['text'].length < 100_000
          ? { id: a.id, title: a.title, kind: 'copy', payload: { text: p['text'] } }
          : null
      case 'url': {
        try {
          const u = new URL(String(p['url']))
          return u.protocol === 'https:' || u.protocol === 'http:'
            ? { id: a.id, title: a.title, kind: 'url', payload: { url: u.toString() } }
            : null
        } catch {
          return null
        }
      }
      case 'open':
      case 'reveal':
        return typeof p['path'] === 'string' && /^(\/|[A-Za-z]:[\\/])/.test(p['path'])
          ? { id: a.id, title: a.title, kind: a.kind, payload: { path: p['path'] } }
          : null
      case 'run':
        // Programs started from extension-supplied text always ask first.
        return typeof p['file'] === 'string' &&
          Array.isArray(p['args']) &&
          p['args'].every((x) => typeof x === 'string')
          ? {
              id: a.id,
              title: a.title,
              kind: 'run',
              confirm: true,
              payload: { file: p['file'], args: p['args'] },
            }
          : null
      case 'custom':
        return { id: a.id, title: a.title, kind: 'custom', payload: null }
    }
  }
  const out: ResultItem[] = []
  for (const i of parsed.data) {
    const primary = fix(i.primary)
    if (!primary) continue
    const actions = (i.actions ?? []).map(fix).filter((x): x is Action => !!x)
    out.push({
      id: `ext:${extId}:${i.id}`,
      providerId: `ext:${extId}`,
      title: i.title,
      kind: 'extension',
      score: i.score ?? 300,
      primary,
      ...(i.subtitle ? { subtitle: i.subtitle } : {}),
      ...(i.icon && !/[\\/.]/.test(i.icon) ? { icon: i.icon } : {}),
      ...(actions.length ? { actions } : {}),
    })
  }
  return out
}

/** Stable hash input for "always allow this command". */
export const commandKey = (file: string, args: string[]): string => JSON.stringify([file, args])

export class ExtensionHost {
  private exts = new Map<string, Running>()
  private seq = 0
  private t: Timer
  constructor(
    private spawn: (e: LoadedExtension) => ExtProc,
    private platform: ExtPlatform,
    opts: { timer?: Timer; now?: () => number } = {},
  ) {
    this.t = opts.timer ?? realTimer
    this.now = opts.now ?? Date.now
  }
  private now: () => number

  state(id: string): State | undefined {
    return this.exts.get(id)?.state
  }

  load(ext: LoadedExtension): void {
    this.unload(ext.manifest.id)
    const r: Running = {
      ext,
      grants: new Grants(ext.manifest.permissions, (p) => this.platform.realpath(p)),
      state: 'running',
      crashes: [],
      pending: new Map(),
    }
    this.exts.set(ext.manifest.id, r)
    this.start(r)
  }

  unload(id: string): void {
    const r = this.exts.get(id)
    if (!r) return
    r.state = 'stopped'
    this.t.clear(r.restartTimer)
    this.failPending(r, new Error('extension stopped'))
    r.proc?.kill()
    this.exts.delete(id)
  }

  private start(r: Running): void {
    const proc = this.spawn(r.ext)
    r.proc = proc
    proc.onMessage((m) => void this.onMessage(r, proc, m as Record<string, unknown>))
    proc.onExit(() => this.onExit(r, proc))
    proc.send({ type: 'init', code: r.ext.code })
  }

  /** Watchdog: restart with growing backoff; stop after repeated crashes. A crash never affects Beacon. */
  private onExit(r: Running, proc: ExtProc): void {
    if (r.proc !== proc || r.state === 'stopped') return
    this.failPending(r, new Error('extension process crashed'))
    const now = this.now()
    r.crashes = [...r.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now]
    if (r.crashes.length > MAX_CRASHES) {
      r.state = 'crashed'
      return
    }
    r.state = 'restarting'
    const delay = BACKOFF_MS[Math.min(r.crashes.length - 1, BACKOFF_MS.length - 1)] as number
    r.restartTimer = this.t.set(() => {
      if (r.state !== 'restarting') return
      r.state = 'running'
      this.start(r)
    }, delay)
  }

  private failPending(r: Running, e: Error): void {
    for (const p of r.pending.values()) {
      this.t.clear(p.timer)
      p.reject(e)
    }
    r.pending.clear()
  }

  private async onMessage(r: Running, proc: ExtProc, m: Record<string, unknown>): Promise<void> {
    if (r.proc !== proc) return
    if (m['type'] === 'invoke-result') {
      const p = r.pending.get(Number(m['id']))
      if (!p) return
      r.pending.delete(Number(m['id']))
      this.t.clear(p.timer)
      if (m['ok']) p.resolve(m['value'])
      else p.reject(new Error(String(m['error'] ?? 'extension error')))
    } else if (m['type'] === 'call') {
      const id = m['id']
      let reply: { ok: boolean; value?: unknown; error?: string }
      try {
        reply = {
          ok: true,
          value: await this.handleCall(r, String(m['op']), String(m['args'] ?? '[]')),
        }
      } catch (e) {
        reply = { ok: false, error: e instanceof Error ? e.message : 'denied' }
      }
      proc.send({ type: 'result', id, json: JSON.stringify(reply) })
    }
  }

  /** The capability gate. Every call is checked; denied calls throw inside the extension. */
  private async handleCall(r: Running, op: string, argsJson: string): Promise<unknown> {
    let args: unknown[]
    try {
      args = JSON.parse(argsJson) as unknown[]
      if (!Array.isArray(args)) throw new Error()
    } catch {
      throw new Error('bad arguments')
    }
    const s = (i: number) => String(args[i] ?? '')
    const id = r.ext.manifest.id
    const deny = (reason: string | null): void => {
      if (reason) throw new Error(`permission denied: ${reason}`)
    }
    const checkOp = async (o: Op) => deny(await r.grants.check(o))
    switch (op) {
      case 'clipboard.read':
        await checkOp({ op })
        return this.platform.clipboardRead()
      case 'clipboard.write':
        await checkOp({ op })
        await this.platform.clipboardWrite(s(0).slice(0, 1_000_000))
        return null
      case 'notify':
        await checkOp({ op })
        await this.platform.notify(
          r.ext.manifest.name,
          s(0).slice(0, 120),
          args[1] === undefined || args[1] === null ? undefined : s(1).slice(0, 300),
        )
        return null
      case 'storage.get':
        await checkOp({ op: 'storage' })
        return this.platform.storageGet(id, s(0))
      case 'storage.set':
        await checkOp({ op: 'storage' })
        if (JSON.stringify(args[1] ?? null).length > 100_000) throw new Error('value too large')
        await this.platform.storageSet(id, s(0), args[1] ?? null)
        return null
      case 'fs.read':
        await checkOp({ op, path: s(0) })
        return this.platform.fsRead(s(0))
      case 'fs.write':
        await checkOp({ op, path: s(0) })
        await this.platform.fsWrite(s(0), s(1))
        return null
      case 'exec': {
        await checkOp({ op, file: s(0) })
        const a = Array.isArray(args[1]) ? (args[1] as unknown[]).map(String) : []
        return this.platform.exec(s(0), a) // argv only; the platform never uses a shell
      }
      case 'fetch': {
        await checkOp({ op, url: s(0) })
        return this.platform.fetch(
          s(0),
          (args[1] ?? {}) as { method?: string; headers?: Record<string, string>; body?: string },
        )
      }
      default:
        throw new Error(`unknown capability: ${op.slice(0, 40)}`)
    }
  }

  private invoke(id: string, method: string, args: unknown[], timeoutMs: number): Promise<unknown> {
    const r = this.exts.get(id)
    if (!r || r.state !== 'running' || !r.proc)
      return Promise.reject(new Error(`extension is ${r?.state ?? 'not loaded'}`))
    const callId = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = this.t.set(() => {
        r.pending.delete(callId)
        reject(new Error('extension timed out'))
      }, timeoutMs)
      r.pending.set(callId, { resolve, reject, timer })
      r.proc?.send({ type: 'invoke', id: callId, method, args })
    })
  }

  async query(
    id: string,
    q: { text: string; terms: string[]; trigger?: string; command?: string },
    timeoutMs = 400,
  ): Promise<ResultItem[]> {
    return sanitizeItems(id, await this.invoke(id, 'query', [q], timeoutMs))
  }

  async activate(
    id: string,
    itemId: string,
    actionId: string | undefined,
    timeoutMs = 5000,
  ): Promise<void> {
    await this.invoke(id, 'activate', [itemId, actionId ?? null], timeoutMs)
  }
}
