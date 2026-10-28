import { spawn } from 'node:child_process'
import type { Action, ParsedQuery, Provider, ProviderContext, ResultItem } from '@beacon/shared'

export interface Run {
  file: string
  args: string[]
  cwd?: string
}

export const copyAction = (text: string, title = 'Copy'): Action => ({
  id: 'copy',
  title,
  kind: 'copy',
  payload: { text },
})

export interface ItemInit {
  id: string
  title: string
  subtitle?: string
  kind: string
  score?: number
  icon?: string
  primary: Action
  actions?: Action[]
  sensitive?: boolean
  preview?: ResultItem['preview']
}

export function item(providerId: string, i: ItemInit): ResultItem {
  const r: ResultItem = {
    id: i.id,
    providerId,
    title: i.title,
    kind: i.kind,
    score: i.score ?? 300,
    primary: i.primary,
  }
  if (i.subtitle !== undefined) r.subtitle = i.subtitle
  if (i.icon) r.icon = i.icon
  if (i.actions?.length) r.actions = i.actions
  if (i.sensitive) r.sensitive = true
  if (i.preview) r.preview = i.preview
  return r
}

/** Spawn argv detached; never a shell string. Resolves on spawn, rejects on spawn error. */
export function spawnArgv(spec: Run, wait = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(spec.file, spec.args, {
      stdio: 'ignore',
      shell: false,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      windowsHide: true,
      detached: !wait,
    })
    c.once('error', reject)
    if (wait) c.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
    else
      c.once('spawn', () => {
        c.unref()
        resolve()
      })
  })
}

/**
 * Base for providers whose results are computed on the fly: remembers the last results
 * so `activate(itemId, actionId)` can find the action to run.
 */
export abstract class LiveProvider implements Provider {
  abstract id: string
  abstract name: string
  mode: 'global' | 'prefix-only' = 'global'
  weight = 1
  triggers?: string[]
  private cache = new Map<string, ResultItem>()

  protected abstract compute(
    q: ParsedQuery,
    ctx: ProviderContext,
    signal: AbortSignal,
  ): Promise<ResultItem[]> | ResultItem[]

  async query(q: ParsedQuery, ctx: ProviderContext, signal: AbortSignal): Promise<ResultItem[]> {
    const items = await this.compute(q, ctx, signal)
    this.cache.clear()
    for (const it of items) this.cache.set(it.id, it)
    return items
  }

  /** Hook for `custom` actions. */
  protected async custom(_action: Action, _item: ResultItem, _ctx: ProviderContext): Promise<void> {
    throw new Error('unsupported action')
  }

  async activate(
    itemId: string,
    actionId: string | undefined,
    ctx: ProviderContext,
  ): Promise<void> {
    const it = this.cache.get(itemId)
    if (!it) throw new Error('result expired')
    const action = actionId
      ? [it.primary, ...(it.actions ?? [])].find((a) => a.id === actionId)
      : it.primary
    if (!action) throw new Error('unknown action')
    await runAction(action, it, ctx, (a) => this.custom(a, it, ctx))
  }
}

export async function runAction(
  a: Action,
  _it: ResultItem,
  ctx: ProviderContext,
  custom: (a: Action) => Promise<void>,
): Promise<void> {
  const p = (a.payload ?? {}) as Record<string, unknown>
  const fx = ctx.effects
  switch (a.kind) {
    case 'copy':
      if (!fx || typeof p['text'] !== 'string') throw new Error('copy unavailable')
      return fx.copy(p['text'])
    case 'open':
    case 'reveal': {
      if (!fx || typeof p['path'] !== 'string') throw new Error('open unavailable')
      return a.kind === 'open' ? fx.openPath(p['path']) : fx.reveal(p['path'])
    }
    case 'url':
      if (!fx || typeof p['url'] !== 'string') throw new Error('url unavailable')
      return fx.openUrl(p['url'])
    case 'run': {
      const steps = (p['steps'] as Run[] | undefined) ?? [p as unknown as Run]
      for (const s of steps) {
        if (typeof s.file !== 'string' || !Array.isArray(s.args)) throw new Error('bad command')
        await spawnArgv(s, steps.length > 1)
      }
      return
    }
    default:
      return custom(a)
  }
}
