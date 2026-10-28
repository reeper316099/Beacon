import type { ResultItem } from '@beacon/shared'
import { compareResults } from './ranking'

/**
 * Result list that never reorders under the cursor. The first batch is sorted
 * freely; later batches are merged only into the region *after* the selection,
 * so rows at or above the selected row never move.
 */
export class StableList {
  items: ResultItem[] = []

  clear(): void {
    this.items = []
  }

  /** Merge a batch. `selectedIndex` is -1 when nothing is selected yet. */
  merge(batch: ResultItem[], selectedIndex: number): void {
    const seen = new Set(this.items.map((i) => i.providerId + '\0' + i.id))
    const fresh = batch.filter((i) => !seen.has(i.providerId + '\0' + i.id))
    if (fresh.length === 0) return
    const keep = Math.max(0, selectedIndex + 1)
    const head = this.items.slice(0, keep)
    const tail = this.items.slice(keep).concat(fresh).sort(compareResults)
    this.items = head.concat(tail)
  }
}
