import type { ResultItem } from '@beacon/shared'
import type { Frecency } from './frecency'

export interface RankContext {
  query: string
  weights?: Record<string, number>
  frecency?: Frecency
}

/** finalScore = matchScore × providerWeight × frecencyBoost. Negative scores are floored at 1. */
export function finalScore(item: ResultItem, ctx: RankContext): number {
  const w = ctx.weights?.[item.providerId] ?? 1
  const f = ctx.frecency ? ctx.frecency.boost(ctx.query, item.frecencyKey ?? item.id) : 1
  return Math.max(item.score, 1) * w * f
}

/** Deterministic ordering: score desc, then provider id, then id. */
export function compareResults(a: ResultItem, b: ResultItem): number {
  if (a.score !== b.score) return b.score - a.score
  if (a.providerId !== b.providerId) return a.providerId < b.providerId ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function rank(items: ResultItem[], ctx: RankContext): ResultItem[] {
  const scored = items.map((it) => ({ ...it, score: finalScore(it, ctx) }))
  return scored.sort(compareResults)
}
