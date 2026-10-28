import { FuzzyIndex } from '@beacon/matcher'
import type { ParsedQuery, ResultItem } from '@beacon/shared'
import { LiveProvider, copyAction, item } from './base'
import { EMOJI } from './emoji-data'

const TONES = ['🏻', '🏼', '🏽', '🏾', '🏿']
// Emoji that accept a Fitzpatrick skin-tone modifier.
const TONEABLE = new Set(['👍', '👎', '👏', '🙌', '👋', '🤝', '💪', '✌️', '🤞', '👌', '🙏'])

export function withTone(ch: string, tone: number): string {
  return ch.replace(/️/g, '') + (TONES[tone] ?? '')
}

export class EmojiProvider extends LiveProvider {
  id = 'emoji'
  name = 'Emoji & symbols'
  mode = 'prefix-only' as const
  triggers = ['emoji ', ': ']
  private index = new FuzzyIndex<[string, string]>(
    EMOJI.map((e) => [e[1], e] as [string, [string, string]]),
  )

  protected compute(q: ParsedQuery): ResultItem[] {
    const text = q.text
    const hits = text ? this.index.search(text, 30).map((r) => r.item) : EMOJI.slice(0, 30)
    return hits.map(([ch, kw], i) =>
      item(this.id, {
        id: `e:${ch}`,
        title: `${ch}  ${kw.split(' ')[0]}`,
        subtitle: kw,
        kind: 'emoji',
        score: 300 - i,
        primary: copyAction(ch),
        actions: TONEABLE.has(ch)
          ? TONES.map((_, t) =>
              copyAction(withTone(ch, t), `Copy skin tone ${t + 1} ${withTone(ch, t)}`),
            ).map((a, t) => ({ ...a, id: `tone${t}` }))
          : [],
      }),
    )
  }
}
