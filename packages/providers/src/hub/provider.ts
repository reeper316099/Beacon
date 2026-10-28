import { promises as fs } from 'node:fs'
import { FuzzyIndex } from '@beacon/matcher'
import type { JsonFile } from '@beacon/jsonstore'
import type { Action, ParsedQuery, ResultItem } from '@beacon/shared'
import { LiveProvider, item, spawnArgv } from '../base'
import type { HubItem, IntegrationsFile, SourceAdapter } from './types'
import { defaultDataDir } from './util'

export const DEFAULT_INTEGRATION = {
  enabled: false,
  deepLinks: false,
  showSpoilers: false,
} as const

export async function detectDir(a: SourceAdapter, cfg?: { dir?: string }): Promise<string | null> {
  const dir = cfg?.dir ?? defaultDataDir(a.dataDirEnv, a.folderName)
  try {
    return (await fs.stat(dir)).isDirectory() ? dir : null
  } catch {
    return null
  }
}

/** One provider per adapter. Off until the user enables it; read-only; cached, refreshed in the background. */
export class HubSourceProvider extends LiveProvider {
  mode = 'global' as const
  weight = 0.9
  private items: HubItem[] = []
  private loadedAt = 0
  private loading: Promise<void> | undefined
  warnings: string[] = []

  constructor(
    private adapter: SourceAdapter,
    private cfg: JsonFile<IntegrationsFile>,
    private ttlMs = 60_000,
  ) {
    super()
    this.triggers = adapter.triggers
  }

  get id(): string {
    return this.adapter.id
  }
  get name(): string {
    return this.adapter.name
  }

  private conf() {
    return { ...DEFAULT_INTEGRATION, ...(this.cfg.data[this.adapter.id] ?? {}) }
  }

  /** Reload now (used after enabling). */
  async reload(): Promise<void> {
    const c = this.conf()
    const dir = c.enabled ? await detectDir(this.adapter, c) : null
    if (!dir) {
      this.items = []
      this.warnings = []
      return
    }
    try {
      const r = await this.adapter.load(dir, { now: new Date(), showSpoilers: c.showSpoilers })
      this.items = r.items
      this.warnings = r.warnings
    } catch {
      this.items = []
      this.warnings = ['could not read data']
    }
    this.loadedAt = Date.now()
  }

  private ensure(): Promise<void> {
    if (!this.conf().enabled) return Promise.resolve()
    if (this.loadedAt === 0)
      return (this.loading ??= this.reload().finally(() => (this.loading = undefined)))
    if (Date.now() - this.loadedAt > this.ttlMs && !this.loading)
      this.loading = this.reload().finally(() => (this.loading = undefined))
    return Promise.resolve() // stale-while-revalidate: never block a keystroke on disk
  }

  /** Rewrite a deeplink primary into "launch the app" until the app is known to handle its scheme. */
  private route(a: Action): Action {
    if (a.kind !== 'deeplink' || this.conf().deepLinks || process.platform !== 'darwin') return a
    return {
      id: 'launch',
      title: `Open ${this.adapter.name}`,
      kind: 'run',
      payload: { file: 'open', args: ['-a', this.adapter.name] },
    }
  }

  protected async compute(q: ParsedQuery): Promise<ResultItem[]> {
    const c = this.conf()
    if (!c.enabled) return []
    await this.ensure()
    // Without a trigger the default list only gets matches (and, when empty, "today" items).
    if (!q.text)
      return this.items
        .filter((i) => i.today)
        .slice(0, 8)
        .map((i, n) => this.toResult(i, 700 - n))
    const hits = new FuzzyIndex(
      this.items.map((i) => [[i.title, ...(i.keywords ?? [])].join(' '), i] as const),
    ).search(q.text, 30)
    return hits.map((h, n) => this.toResult(h.item, h.score + (h.item.boost ?? 0) * 5 - n * 0))
  }

  private toResult(i: HubItem, score: number): ResultItem {
    const dl =
      i.primary.kind === 'deeplink'
        ? [
            {
              id: 'copy-link',
              title: 'Copy deep link',
              kind: 'copy' as const,
              payload: { text: (i.primary.payload as { url: string }).url },
            },
          ]
        : []
    return item(this.id, {
      id: i.id,
      title: i.title,
      kind: i.kind,
      score,
      ...(i.subtitle ? { subtitle: i.subtitle } : {}),
      primary: this.route(i.primary),
      actions: [
        ...(i.actions ?? []),
        ...(i.primary.kind === 'deeplink'
          ? [{ ...i.primary, id: 'deeplink', title: `Try ${this.adapter.scheme}:// link` }]
          : []),
        ...dl,
      ],
      ...(i.preview ? { preview: i.preview } : {}),
    })
  }
}

/** `hub` command: enable/disable integrations (asks first), shows detected folders and warnings. */
export class HubSetupProvider extends LiveProvider {
  id = 'hub'
  name = 'My apps'
  mode = 'prefix-only' as const
  triggers = ['hub ', 'hub', 'integrations ']
  constructor(
    private adapters: SourceAdapter[],
    private cfg: JsonFile<IntegrationsFile>,
    private providers: Map<string, HubSourceProvider>,
  ) {
    super()
  }
  protected async compute(): Promise<ResultItem[]> {
    const out: ResultItem[] = []
    for (const a of this.adapters) {
      const c = { ...DEFAULT_INTEGRATION, ...(this.cfg.data[a.id] ?? {}) }
      const dir = await detectDir(a, c)
      const warns = this.providers.get(a.id)?.warnings ?? []
      out.push(
        item(this.id, {
          id: `hub:${a.id}`,
          title: `${c.enabled ? 'Disable' : 'Enable'} ${a.name}`,
          subtitle: c.enabled
            ? `Reading ${dir ?? 'folder missing'}${warns.length ? ` · ${warns.length} warning(s)` : ''}`
            : dir
              ? `Found ${dir} · read-only`
              : 'Data folder not found',
          kind: 'integration',
          score: dir || c.enabled ? 500 : 100,
          primary: {
            id: c.enabled ? 'disable' : 'enable',
            title: c.enabled ? 'Disable' : 'Enable (read-only)',
            kind: 'custom',
            confirm: !c.enabled,
            payload: { id: a.id },
          },
          actions: [
            { id: 'refresh', title: 'Reload now', kind: 'custom', payload: { id: a.id } },
            {
              id: 'deeplinks',
              title: c.deepLinks
                ? 'Open launches the app (turn deep links off)'
                : `My ${a.name} handles ${a.scheme}:// links (turn deep links on)`,
              kind: 'custom',
              payload: { id: a.id },
            },
            ...(a.id === 'worldloom'
              ? [
                  {
                    id: 'spoilers',
                    title: c.showSpoilers
                      ? 'Hide spoilers again'
                      : 'Show spoilers (off by default)',
                    kind: 'custom' as const,
                    confirm: !c.showSpoilers,
                    payload: { id: a.id },
                  },
                ]
              : []),
            ...warns.slice(0, 5).map((w, i) => ({
              id: `w${i}`,
              title: `⚠ ${w}`,
              kind: 'custom' as const,
              payload: { id: a.id },
            })),
          ],
        }),
      )
    }
    return out
  }
  protected async custom(a: Action): Promise<void> {
    const id = (a.payload as { id?: string } | null)?.id
    if (!id || !this.adapters.some((x) => x.id === id)) return
    const patch = (
      fn: (
        c: Required<
          Pick<NonNullable<IntegrationsFile[string]>, 'enabled' | 'deepLinks' | 'showSpoilers'>
        > & { dir?: string },
      ) => object,
    ) =>
      this.cfg.update((d) => ({
        ...d,
        [id]: {
          ...DEFAULT_INTEGRATION,
          ...(d[id] ?? {}),
          ...fn({ ...DEFAULT_INTEGRATION, ...(d[id] ?? {}) }),
        },
      }))
    if (a.id === 'enable') await patch(() => ({ enabled: true }))
    else if (a.id === 'disable') await patch(() => ({ enabled: false }))
    else if (a.id === 'deeplinks') await patch((c) => ({ deepLinks: !c.deepLinks }))
    else if (a.id === 'spoilers') await patch((c) => ({ showSpoilers: !c.showSpoilers }))
    await this.providers.get(id)?.reload()
  }
}

export { spawnArgv }
