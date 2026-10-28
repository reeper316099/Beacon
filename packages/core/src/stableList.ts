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

  /**
   * Merge a batch. `selectedIndex` is -1 when nothing is selected yet.
   * A duplicate (same provider + id) with a higher score replaces the existing row *in place*
   * (e.g. an alias result upgrading the plain app row); positions of rows at or above the
   * selection never change.
   */
  merge(batch: ResultItem[], selectedIndex: number): void {
    const key = (i: ResultItem) => i.providerId + '\0' + i.id
    const at = new Map(this.items.map((i, n) => [key(i), n]))
    const fresh: ResultItem[] = []
    for (const it of batch) {
      const n = at.get(key(it))
      if (n === undefined) {
        fresh.push(it)
        at.set(key(it), -1) // later duplicates within the same batch are dropped
      } else if (n >= 0 && it.score > (this.items[n] as ResultItem).score) this.items[n] = it
    }
    const keep = Math.max(0, selectedIndex + 1)
    const head = this.items.slice(0, keep)
    const tail = this.items.slice(keep).concat(fresh).sort(compareResults)
    this.items = head.concat(tail)
  }
}
