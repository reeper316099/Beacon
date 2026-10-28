import type { ParsedQuery, ResultItem } from '@beacon/shared'
import { LiveProvider, item } from './base'

export interface Quicklink {
  keyword: string
  name: string
  /** URL template with {query}. */
  url: string
}

export const DEFAULT_QUICKLINKS: Quicklink[] = [
  { keyword: 'g', name: 'Search the web', url: 'https://www.google.com/search?q={query}' },
  { keyword: 'ddg', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={query}' },
  { keyword: 'yt', name: 'YouTube', url: 'https://www.youtube.com/results?search_query={query}' },
  { keyword: 'gh', name: 'GitHub', url: 'https://github.com/search?q={query}' },
  {
    keyword: 'mdn',
    name: 'MDN Web Docs',
    url: 'https://developer.mozilla.org/en-US/search?q={query}',
  },
  {
    keyword: 'wiki',
    name: 'Wikipedia',
    url: 'https://en.wikipedia.org/w/index.php?search={query}',
  },
  { keyword: 'maps', name: 'Maps', url: 'https://www.openstreetmap.org/search?query={query}' },
]

/** Build a URL; only http(s) is allowed. Returns null for anything else. */
export function buildUrl(template: string, query: string): string | null {
  let u: URL
  try {
    u = new URL(template.replace(/\{query\}/g, encodeURIComponent(query)))
  } catch {
    return null
  }
  return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
}

export class QuicklinkProvider extends LiveProvider {
  id = 'quicklinks'
  name = 'Web quicklinks'
  mode = 'prefix-only' as const
  triggers: string[] = []
  private links: Quicklink[] = []

  constructor(links: Quicklink[] = DEFAULT_QUICKLINKS) {
    super()
    this.setLinks(links)
  }

  setLinks(links: Quicklink[]): void {
    this.links = links
    this.triggers.length = 0
    this.triggers.push(...links.map((l) => l.keyword + ' '))
  }

  protected compute(q: ParsedQuery): ResultItem[] {
    const kw = q.trigger?.trim().toLowerCase()
    const link = this.links.find((l) => l.keyword.toLowerCase() === kw)
    const text = q.text
    if (!link || !text) return []
    const url = buildUrl(link.url, q.raw.slice((q.trigger ?? '').length).trim())
    if (!url) return []
    return [
      item(this.id, {
        id: `${link.keyword}:${text}`,
        title: `${link.name}: ${text}`,
        subtitle: new URL(url).hostname,
        kind: 'web',
        score: 500,
        primary: { id: 'open', title: 'Open in browser', kind: 'url', payload: { url } },
        actions: [{ id: 'copy', title: 'Copy URL', kind: 'copy', payload: { text: url } }],
      }),
    ]
  }
}
