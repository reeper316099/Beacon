import type { JsonFile } from '@beacon/jsonstore'
import type { Action, ParsedQuery, ResultItem } from '@beacon/shared'
import { LiveProvider, item } from '../base'
import { commandKey } from './host'

/** What the worker knows about an extension (sent by the main process). */
export interface ExtInfo {
  id: string
  name: string
  version: string
  description?: string
  keywords: string[]
  /** Human-readable permissions, shown before enabling. */
  permissions: string[]
  state: 'enabled' | 'disabled' | 'needs-consent' | 'restarting' | 'crashed' | 'invalid'
  error?: string
}

export interface ExtBridge {
  query(
    id: string,
    q: { text: string; terms: string[]; trigger?: string; command?: string },
  ): Promise<ResultItem[]>
  activate(id: string, itemId: string, actionId: string | undefined): Promise<void>
  admin(op: 'enable' | 'disable' | 'remove' | 'reload' | 'open-folder', id: string): Promise<void>
}

/** One provider per enabled extension; the code itself runs in an isolated process owned by the main process. */
export class ExtensionProxyProvider extends LiveProvider {
  mode = 'prefix-only' as const
  triggers: string[]
  timeoutMs = 600
  constructor(
    private info: ExtInfo,
    private bridge: ExtBridge,
    private trusted: JsonFile<string[]>,
  ) {
    super()
    this.triggers = info.keywords.map((k) => k + ' ')
  }
  get id(): string {
    return 'ext:' + this.info.id
  }
  get name(): string {
    return this.info.name
  }

  protected async compute(q: ParsedQuery): Promise<ResultItem[]> {
    const items = await this.bridge.query(this.info.id, {
      text: q.text,
      terms: q.terms,
      ...(q.trigger ? { trigger: q.trigger } : {}),
      ...(q.command ? { command: q.command } : {}),
    })
    const allowed = new Set(this.trusted.data)
    return items.map((it) => {
      const run = [it.primary, ...(it.actions ?? [])].find((a) => a.kind === 'run')
      if (!run) return it
      const p = run.payload as { file: string; args: string[] }
      const key = commandKey(p.file, p.args)
      const trusted = allowed.has(key)
      const patch = (a: Action): Action =>
        a.kind === 'run' && trusted ? { ...a, confirm: false } : a
      return {
        ...it,
        primary: patch(it.primary),
        actions: [
          ...(it.actions ?? []).map(patch),
          ...(trusted
            ? []
            : [
                {
                  id: 'trust-command',
                  title: 'Always allow this exact command',
                  kind: 'custom' as const,
                  confirm: true,
                  payload: { key },
                },
              ]),
        ],
      }
    })
  }

  protected async custom(a: Action, it: ResultItem): Promise<void> {
    if (a.id === 'trust-command') {
      const key = (a.payload as { key: string }).key
      await this.trusted.update((d) => (d.includes(key) ? d : [...d, key]))
      return
    }
    // Extension-defined actions run inside the extension (item ids are namespaced; strip the prefix).
    await this.bridge.activate(this.info.id, it.id.replace(`ext:${this.info.id}:`, ''), a.id)
  }
}

/** `ext` command: list, enable (the host shows the permission prompt), disable, remove, reload. */
export class ExtensionAdminProvider extends LiveProvider {
  id = 'extensions'
  name = 'Extensions'
  mode = 'prefix-only' as const
  triggers = ['ext ', 'ext', 'extensions ']
  constructor(
    private list: () => ExtInfo[],
    private bridge: ExtBridge,
  ) {
    super()
  }
  protected compute(): ResultItem[] {
    const infos = this.list()
    if (!infos.length)
      return [
        item(this.id, {
          id: 'none',
          title: 'No extensions installed',
          subtitle:
            'Put an extension folder (manifest.json + code) in the extensions folder. Only install extensions you trust.',
          kind: 'extension',
          score: 100,
          primary: {
            id: 'open-folder',
            title: 'Open extensions folder',
            kind: 'custom',
            payload: { id: '' },
          },
        }),
      ]
    return infos.map((e, i) => {
      const on = e.state === 'enabled' || e.state === 'restarting'
      return item(this.id, {
        id: 'x:' + e.id,
        title: `${on ? 'Disable' : e.state === 'invalid' ? 'Invalid:' : 'Enable'} ${e.name} ${e.version}`,
        subtitle:
          e.state === 'invalid'
            ? (e.error ?? 'invalid manifest')
            : on
              ? `Running${e.state === 'restarting' ? ' (restarting)' : ''} · ${e.permissions.length ? e.permissions.join(' · ') : 'no permissions'}`
              : `${e.state === 'crashed' ? 'Stopped after repeated crashes · ' : e.state === 'needs-consent' ? 'Permissions changed · ' : ''}Wants: ${e.permissions.length ? e.permissions.join(' · ') : 'no permissions'}`,
        kind: 'extension',
        score: 500 - i,
        primary:
          e.state === 'invalid'
            ? {
                id: 'open-folder',
                title: 'Open extensions folder',
                kind: 'custom',
                payload: { id: '' },
              }
            : {
                id: on ? 'disable' : 'enable',
                title: on ? 'Disable' : 'Review permissions & enable',
                kind: 'custom',
                payload: { id: e.id },
              },
        actions: [
          { id: 'reload', title: 'Reload', kind: 'custom', payload: { id: e.id } },
          {
            id: 'remove',
            title: 'Remove (moves the folder to the trash)',
            kind: 'custom',
            confirm: true,
            payload: { id: e.id },
          },
        ],
      })
    })
  }
  protected async custom(a: Action): Promise<void> {
    const id = (a.payload as { id?: string } | null)?.id ?? ''
    if (['enable', 'disable', 'remove', 'reload', 'open-folder'].includes(a.id))
      await this.bridge.admin(a.id as 'enable', id)
  }
}
