import type { JsonFile } from '@beacon/jsonstore'
import type { Action, ParsedQuery, ProviderContext, ResultItem } from '@beacon/shared'
import { LiveProvider, item } from './base'

/** Pinned items are stored as full snapshots so they can be shown without re-querying their provider. */
export type PinList = ResultItem[]
export interface AliasRec {
  providerId: string
  itemId: string
  title: string
  icon?: string
  primary: Action
  actions?: Action[]
}
export type AliasMap = Record<string, AliasRec>

const key = (i: { providerId: string; id: string }) => `${i.providerId}\0${i.id}`

export class PinStore {
  constructor(readonly file: JsonFile<PinList>) {}
  list(): PinList {
    return this.file.data
  }
  has(i: { providerId: string; id: string }): boolean {
    return this.file.data.some((p) => key(p) === key(i))
  }
  /** Toggle; sensitive items (clipboard) can't be pinned this way. Returns the new pinned state. */
  async toggle(i: ResultItem): Promise<boolean> {
    if (i.sensitive) return false
    const was = this.has(i)
    await this.file.update((d) =>
      was ? d.filter((p) => key(p) !== key(i)) : [...d, { ...i, score: 1000 }],
    )
    return !was
  }
}

/** Empty-query pins. */
export class PinsProvider extends LiveProvider {
  id = 'pins'
  name = 'Pinned'
  constructor(private pins: PinStore) {
    super()
  }
  protected compute(q: ParsedQuery): ResultItem[] {
    if (q.text) return []
    return this.pins
      .list()
      .map((p, i) => ({ ...p, subtitle: p.subtitle ?? 'Pinned', score: 1000 - i }))
  }
  // Pinned items execute on their original provider (their providerId is unchanged).
  override async activate(): Promise<void> {
    throw new Error('pinned items are activated by their own provider')
  }
}

/** Exact-alias lookup: typing "ff" surfaces the item bound to it. */
export class AliasProvider extends LiveProvider {
  id = 'aliases'
  name = 'Aliases'
  constructor(readonly file: JsonFile<AliasMap>) {
    super()
  }
  protected compute(q: ParsedQuery): ResultItem[] {
    if (q.trigger) return []
    const a = this.file.data[q.raw.trim().toLowerCase()]
    if (!a) return []
    return [
      {
        id: a.itemId,
        providerId: a.providerId,
        title: a.title,
        subtitle: `Alias “${q.raw.trim()}”`,
        kind: 'alias',
        score: 5000,
        primary: a.primary,
        ...(a.icon ? { icon: a.icon } : {}),
        ...(a.actions ? { actions: a.actions } : {}),
      },
    ]
  }
  override async activate(): Promise<void> {
    throw new Error('alias results are activated by their own provider')
  }
}

export type Resolver = (text: string) => Promise<ResultItem | undefined>

/**
 * `alias ff firefox` binds "ff" to the top result for "firefox".
 * `hotkey Ctrl+Alt+F firefox` binds a global hotkey to it.
 */
export class BindProvider extends LiveProvider {
  mode = 'prefix-only' as const
  triggers: string[]
  constructor(
    readonly id: 'alias' | 'hotkey',
    readonly name: string,
    private aliases: JsonFile<AliasMap>,
    private resolve: Resolver,
  ) {
    super()
    this.triggers = [id + ' ']
  }
  protected async compute(q: ParsedQuery): Promise<ResultItem[]> {
    const [name, ...rest] = q.terms
    const target = rest.join(' ')
    if (!name || !target) {
      const list = this.id === 'alias' ? Object.entries(this.aliases.data) : []
      return list.map(([k, a]) =>
        item(this.id, {
          id: 'rm:' + k,
          title: `${k} → ${a.title}`,
          kind: 'alias',
          score: 300,
          primary: {
            id: 'remove',
            title: 'Remove alias',
            kind: 'custom',
            confirm: true,
            payload: { alias: k },
          },
        }),
      )
    }
    const found = await this.resolve(target)
    if (!found)
      return [
        item(this.id, {
          id: 'none',
          title: `No result for “${target}”`,
          kind: 'alias',
          score: 1,
          primary: { id: 'noop', title: 'OK', kind: 'custom', payload: null },
        }),
      ]
    const rec: AliasRec = {
      providerId: found.providerId,
      itemId: found.id,
      title: found.title,
      primary: found.primary,
      ...(found.icon ? { icon: found.icon } : {}),
      ...(found.actions ? { actions: found.actions } : {}),
    }
    return [
      item(this.id, {
        id: `${this.id}:${name}:${found.id}`,
        title:
          this.id === 'alias'
            ? `Alias “${name}” → ${found.title}`
            : `Hotkey ${name} → ${found.title}`,
        kind: this.id,
        score: 900,
        primary: {
          id: 'bind',
          title: this.id === 'alias' ? 'Create alias' : 'Bind hotkey',
          kind: 'custom',
          payload: { name, rec },
        },
      }),
    ]
  }
  protected async custom(a: Action, _it: ResultItem, ctx: ProviderContext): Promise<void> {
    const p = a.payload as { name?: string; rec?: AliasRec; alias?: string }
    if (a.id === 'bind' && p.name && p.rec) {
      if (this.id === 'alias') {
        const k = p.name.toLowerCase()
        await this.aliases.update((d) => ({ ...d, [k]: p.rec as AliasRec }))
      } else await ctx.effects?.bindHotkey(p.name, p.rec.providerId, p.rec.itemId, p.rec.title)
    } else if (a.id === 'remove' && p.alias) {
      await this.aliases.update((d) => {
        const n = { ...d }
        delete n[p.alias as string]
        return n
      })
    }
  }
}
