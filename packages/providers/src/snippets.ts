import type { Action, ParsedQuery, ProviderContext, ResultItem } from '@beacon/shared'
import { FuzzyIndex } from '@beacon/matcher'
import type { JsonFile } from '@beacon/jsonstore'
import { LiveProvider, copyAction, item } from './base'

export interface Snippet {
  id: string
  title: string
  body: string
  tags: string[]
  folder: string
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

export function formatDate(fmt: string, d: Date): string {
  return fmt
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/DD/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()))
}

export function placeholders(body: string): { prompts: string[] } {
  const prompts = [...body.matchAll(/\{prompt:([A-Za-z0-9_-]+)\}/g)].map((m) => m[1] as string)
  return { prompts: [...new Set(prompts)] }
}

/** Expand {clipboard}, {date:FMT}, {prompt:name}, {cursor}. Unknown braces are left as-is. */
export function expandSnippet(
  body: string,
  ctx: { now: Date; clipboard: string; prompts?: Record<string, string> },
): string {
  return body
    .replace(/\{clipboard\}/g, () => ctx.clipboard)
    .replace(/\{date:([^}]+)\}/g, (_m, f: string) => formatDate(f, ctx.now))
    .replace(/\{prompt:([A-Za-z0-9_-]+)\}/g, (_m, n: string) => ctx.prompts?.[n] ?? '')
    .replace(/\{cursor\}/g, '')
}

const sid = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

export class SnippetProvider extends LiveProvider {
  id = 'snippets'
  name = 'Snippets'
  mode = 'prefix-only' as const
  triggers = ['snip ', 'snip']
  constructor(private file: JsonFile<Snippet[]>) {
    super()
  }

  /** `snip new Title :: body` creates; otherwise fuzzy search. `key=value` words fill {prompt:key}. */
  protected compute(q: ParsedQuery): ResultItem[] {
    const raw = q.raw.slice((q.trigger ?? '').length).trim()
    const mk = /^new\s+(.+?)\s*::\s*([\s\S]+)$/.exec(raw)
    if (mk)
      return [
        item(this.id, {
          id: 'new:' + mk[1],
          title: `Create snippet “${mk[1]}”`,
          subtitle: (mk[2] as string).slice(0, 80),
          kind: 'snippet',
          score: 900,
          primary: {
            id: 'create',
            title: 'Create snippet',
            kind: 'custom',
            payload: { title: mk[1], body: mk[2] },
          },
        }),
      ]
    const prompts: Record<string, string> = {}
    const words = q.terms.filter((t) => {
      const m = /^([A-Za-z0-9_-]+)=(.*)$/.exec(t)
      if (m) prompts[m[1] as string] = m[2] as string
      return !m
    })
    const text = words.join(' ')
    const all = this.file.data
    const hits = text
      ? new FuzzyIndex(all.map((s) => [[s.title, ...s.tags, s.folder].join(' '), s] as const))
          .search(text, 30)
          .map((r) => r.item)
      : all.slice(0, 30)
    return hits.map((s, i) => {
      const missing = placeholders(s.body).prompts.filter((p) => !(p in prompts))
      return item(this.id, {
        id: s.id,
        title: s.title,
        subtitle: missing.length
          ? `needs ${missing.map((m) => m + '=…').join(' ')}`
          : s.body.replace(/\s+/g, ' ').slice(0, 80),
        kind: 'snippet',
        score: 500 - i,
        primary: {
          id: 'expand',
          title: 'Copy snippet',
          kind: 'custom',
          payload: { id: s.id, prompts },
        },
        actions: [
          {
            id: 'delete',
            title: 'Delete snippet',
            kind: 'custom',
            confirm: true,
            payload: { id: s.id },
          },
        ],
      })
    })
  }

  protected async custom(a: Action, _it: ResultItem, ctx: ProviderContext): Promise<void> {
    const p = a.payload as {
      id?: string
      title?: string
      body?: string
      prompts?: Record<string, string>
    }
    if (a.id === 'create' && p.title && p.body) {
      await this.file.update((d) => [
        ...d,
        { id: sid(), title: p.title as string, body: p.body as string, tags: [], folder: '' },
      ])
    } else if (a.id === 'delete') {
      await this.file.update((d) => d.filter((s) => s.id !== p.id))
    } else if (a.id === 'expand') {
      const s = this.file.data.find((x) => x.id === p.id)
      if (!s) throw new Error('snippet not found')
      const clip = s.body.includes('{clipboard}') ? await (ctx.effects?.readClipboard() ?? '') : ''
      await ctx.effects?.copy(
        expandSnippet(s.body, {
          now: new Date(ctx.now()),
          clipboard: clip,
          prompts: p.prompts ?? {},
        }),
      )
    }
  }
}

export { copyAction }
