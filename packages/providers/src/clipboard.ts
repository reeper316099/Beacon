import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { atomicWrite } from '@beacon/jsonstore'
import { FuzzyIndex } from '@beacon/matcher'
import type { Action, ParsedQuery, ProviderContext, ResultItem } from '@beacon/shared'
import { LiveProvider, copyAction, item } from './base'

export interface ClipEntry {
  id: string
  kind: 'text' | 'image'
  text?: string
  /** Image content hash (file lives in clipboard/images/<hash>.png, written by the app). */
  imageHash?: string
  bytes: number
  ts: number
  pinned?: boolean
}

export interface ClipboardOptions {
  path: string
  now?: () => number
  retentionMs?: number
  maxItems?: number
  maxTextBytes?: number
  /** Copies whose text matches any pattern are never stored. */
  ignore?: RegExp[]
}

const DAY = 86_400_000
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** Clipboard history: dedupe, retention, pinning, exclusion rules. Local only. */
export class ClipboardStore {
  private entries: ClipEntry[] = []
  paused = false
  private o: Required<Omit<ClipboardOptions, 'path' | 'now'>> & { path: string; now: () => number }
  private timer: NodeJS.Timeout | undefined

  constructor(opts: ClipboardOptions) {
    this.o = {
      path: opts.path,
      now: opts.now ?? Date.now,
      retentionMs: opts.retentionMs ?? 7 * DAY,
      maxItems: opts.maxItems ?? 500,
      maxTextBytes: opts.maxTextBytes ?? 1_000_000,
      ignore: opts.ignore ?? [],
    }
  }

  configure(c: { retentionMs?: number; maxItems?: number; ignore?: RegExp[] }): void {
    Object.assign(this.o, Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)))
    this.prune()
  }

  async load(): Promise<void> {
    let text = ''
    try {
      text = await fs.readFile(this.o.path, 'utf8')
    } catch {
      return
    }
    this.entries = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as ClipEntry
        if (e && typeof e.id === 'string' && typeof e.ts === 'number') this.entries.push(e)
      } catch {
        /* skip corrupt line */
      }
    }
    this.prune()
  }

  /** Returns the stored entry, or null when ignored (paused, concealed, too large, excluded). */
  addText(text: string, opts: { concealed?: boolean } = {}): ClipEntry | null {
    if (this.paused || opts.concealed || !text.trim()) return null
    const bytes = Buffer.byteLength(text)
    if (bytes > this.o.maxTextBytes) return null
    if (this.o.ignore.some((re) => re.test(text))) return null
    return this.upsert({ id: 't' + sha(text), kind: 'text', text, bytes })
  }

  addImage(hash: string, bytes: number, opts: { concealed?: boolean } = {}): ClipEntry | null {
    if (this.paused || opts.concealed) return null
    return this.upsert({ id: 'i' + hash, kind: 'image', imageHash: hash, bytes })
  }

  private upsert(e: Omit<ClipEntry, 'ts'>): ClipEntry {
    const prev = this.entries.find((x) => x.id === e.id)
    const entry: ClipEntry = { ...e, ts: this.o.now(), ...(prev?.pinned ? { pinned: true } : {}) }
    this.entries = this.entries.filter((x) => x.id !== e.id)
    this.entries.unshift(entry)
    this.prune()
    this.schedule()
    return entry
  }

  /** Drop expired and excess items; pinned items are kept. */
  prune(): void {
    const cutoff = this.o.now() - this.o.retentionMs
    this.entries = this.entries.filter((e) => e.pinned || e.ts >= cutoff)
    let unpinned = 0
    this.entries = this.entries.filter((e) => e.pinned || ++unpinned <= this.o.maxItems)
  }

  list(): ClipEntry[] {
    return [...this.entries].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.ts - a.ts)
  }

  get(id: string): ClipEntry | undefined {
    return this.entries.find((e) => e.id === id)
  }

  togglePin(id: string): boolean {
    const e = this.get(id)
    if (!e) return false
    e.pinned = !e.pinned || undefined
    this.schedule()
    return true
  }

  remove(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id)
    this.schedule()
  }

  /** Returns image hashes whose files the app should delete. */
  wipe(): string[] {
    const imgs = this.entries.flatMap((e) => (e.imageHash ? [e.imageHash] : []))
    this.entries = []
    this.schedule()
    return imgs
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, 1000)
    this.timer.unref?.()
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    await atomicWrite(this.o.path, this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  }
}

const preview = (s: string, n = 90) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

export class ClipboardProvider extends LiveProvider {
  id = 'clipboard'
  name = 'Clipboard history'
  mode = 'prefix-only' as const
  triggers = ['cb ', 'cb']
  constructor(
    readonly store: ClipboardStore,
    private onWipe: (imageHashes: string[]) => void = () => {},
  ) {
    super()
  }

  protected compute(q: ParsedQuery, ctx: ProviderContext): ResultItem[] {
    // Clipboard results are sensitive: they only appear behind the explicit "cb" trigger.
    if (q.text === 'wipe')
      return [
        item(this.id, {
          id: 'wipe',
          title: 'Wipe all clipboard history',
          subtitle: 'Pinned items too. Cannot be undone.',
          kind: 'clipboard',
          score: 900,
          sensitive: true,
          primary: {
            id: 'wipe',
            title: 'Wipe history',
            kind: 'custom',
            confirm: true,
            payload: null,
          },
        }),
      ]
    const all = this.store.list()
    const hits = q.text
      ? new FuzzyIndex(
          all.filter((e) => e.kind === 'text').map((e) => [e.text as string, e] as const),
        )
          .search(q.text, 40)
          .map((r) => r.item)
      : all.slice(0, 40)
    const out = hits.map((e, i) => {
      const pin: Action = {
        id: 'pin',
        title: e.pinned ? 'Unpin' : 'Pin',
        kind: 'custom',
        payload: null,
      }
      const del: Action = {
        id: 'delete',
        title: 'Delete from history',
        kind: 'custom',
        confirm: true,
        payload: null,
      }
      const ago = Math.max(0, Math.round((ctx.now() - e.ts) / 60000))
      const when =
        ago < 1
          ? 'just now'
          : ago < 60
            ? `${ago}m ago`
            : ago < 1440
              ? `${Math.round(ago / 60)}h ago`
              : `${Math.round(ago / 1440)}d ago`
      return item(this.id, {
        id: e.id,
        title:
          e.kind === 'text'
            ? preview(e.text as string)
            : `Image (${Math.round(e.bytes / 1024)} KB)`,
        subtitle: `${e.pinned ? '📌 ' : ''}${when}`,
        kind: 'clipboard',
        score: 500 - i,
        sensitive: true,
        primary:
          e.kind === 'text'
            ? copyAction(e.text as string)
            : {
                id: 'copy-image',
                title: 'Copy image',
                kind: 'custom',
                payload: { hash: e.imageHash },
              },
        actions: [pin, del],
      })
    })
    return out
  }

  async forget(itemId: string): Promise<void> {
    this.store.remove(itemId)
  }

  protected async custom(a: Action, it: ResultItem, ctx: ProviderContext): Promise<void> {
    if (a.id === 'wipe') this.onWipe(this.store.wipe())
    else if (a.id === 'pin') this.store.togglePin(it.id)
    else if (a.id === 'delete') this.store.remove(it.id)
    else if (a.id === 'copy-image')
      await ctx.effects?.copyImage(String((a.payload as { hash: string }).hash))
  }
}
