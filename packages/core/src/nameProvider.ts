import { FuzzyIndex } from '@beacon/matcher'
import type { Action, ParsedQuery, Provider, ResultItem } from '@beacon/shared'

export interface NameEntry {
  id: string
  title: string
  subtitle?: string
  kind: string
  keywords?: string[]
  primary: Action
}

/** Generic fuzzy provider over a name index (apps, files, ...). */
export class NameIndexProvider implements Provider {
  mode: 'global' | 'prefix-only' = 'global'
  weight = 1
  private index = new FuzzyIndex<NameEntry>()

  constructor(
    public id: string,
    public name: string,
    public triggers?: string[],
    private limit = 50,
  ) {}

  set(entries: NameEntry[]): void {
    this.index.clear()
    for (const e of entries) this.index.add([e.title, ...(e.keywords ?? [])].join(' '), e)
  }

  async query(q: ParsedQuery): Promise<ResultItem[]> {
    if (!q.text) return []
    return this.index.search(q.text, this.limit).map(({ item, score }) => {
      const r: ResultItem = {
        id: item.id,
        providerId: this.id,
        title: item.title,
        kind: item.kind,
        score,
        primary: item.primary,
      }
      if (item.subtitle !== undefined) r.subtitle = item.subtitle
      return r
    })
  }
}
