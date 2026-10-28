import type { ParsedQuery } from '@beacon/shared'

export const FILTER_KEYS = ['type', 'in', 'ext', 'app'] as const

/** Split on whitespace, honoring "double" and 'single' quotes. Unterminated quotes run to the end. */
export function tokenize(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (has || cur) out.push(cur)
  return out
}

/**
 * Pure query parser. A trigger must match the start of the input (case-insensitive,
 * longest wins) and, if it ends in a space, that space must be present.
 */
export function parseQuery(
  raw: string,
  triggers: readonly string[] = [],
  filterKeys: readonly string[] = FILTER_KEYS,
): ParsedQuery {
  const input = typeof raw === 'string' ? raw : ''
  let rest = input
  let trigger: string | undefined
  const lower = input.toLowerCase()
  for (const t of [...triggers].sort((a, b) => b.length - a.length)) {
    if (t && lower.startsWith(t.toLowerCase())) {
      trigger = t
      rest = input.slice(t.length)
      break
    }
  }

  const filters: Record<string, string> = {}
  const terms: string[] = []
  for (const tok of tokenize(rest)) {
    const i = tok.indexOf(':')
    if (i > 0 && i < tok.length - 1) {
      const key = tok.slice(0, i).toLowerCase()
      if (filterKeys.includes(key)) {
        filters[key] = tok.slice(i + 1)
        continue
      }
    }
    terms.push(tok)
  }

  const parsed: ParsedQuery = {
    raw: input,
    text: terms.join(' '),
    terms,
    filters,
    args: trigger ? terms.slice(1) : [],
  }
  if (trigger !== undefined) {
    parsed.trigger = trigger
    if (terms[0] !== undefined) parsed.command = terms[0]
  }
  return parsed
}
