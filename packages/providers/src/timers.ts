export interface TimerRec {
  id: string
  label: string
  /** Epoch ms when it fires. */
  endsAt: number
  startedAt: number
}

/** "25m", "1h30m", "90s", "1.5h", "45" (minutes). Returns ms or null. */
export function parseDuration(s: string): number | null {
  const t = s.trim().toLowerCase()
  let total: number
  if (/^\d+(\.\d+)?$/.test(t)) total = Number(t) * 60_000
  else if (/^(\d+(\.\d+)?\s*[hms]\s*)+$/.test(t)) {
    total = 0
    for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*([hms])/g))
      total += Number(m[1]) * { h: 3_600_000, m: 60_000, s: 1000 }[m[2] as 'h' | 'm' | 's']
  } else return null
  total = Math.round(total)
  return total > 0 && total <= 7 * 86_400_000 ? total : null
}

export const formatRemaining = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}h ${m}m` : m ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`
}

export interface TimerHooks {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
  onFire(t: TimerRec): void
  onChange?(all: TimerRec[]): void
}

export class TimerStore {
  private timers = new Map<string, TimerRec>()
  private handles = new Map<string, unknown>()
  private seq = 0
  constructor(private h: TimerHooks) {}

  list(): TimerRec[] {
    return [...this.timers.values()].sort((a, b) => a.endsAt - b.endsAt)
  }

  restore(recs: TimerRec[]): void {
    for (const r of recs) {
      if (r.endsAt <= this.h.now()) continue // expired while Beacon was closed
      this.schedule(r)
    }
  }

  start(ms: number, label: string): TimerRec {
    const now = this.h.now()
    const rec: TimerRec = {
      id: `t${now}-${++this.seq}`,
      label: label || 'Timer',
      startedAt: now,
      endsAt: now + ms,
    }
    this.schedule(rec)
    this.h.onChange?.(this.list())
    return rec
  }

  private schedule(r: TimerRec): void {
    this.timers.set(r.id, r)
    this.handles.set(
      r.id,
      this.h.setTimeout(
        () => {
          this.timers.delete(r.id)
          this.handles.delete(r.id)
          this.h.onChange?.(this.list())
          this.h.onFire(r)
        },
        Math.max(0, r.endsAt - this.h.now()),
      ),
    )
  }

  cancel(id: string): boolean {
    const had = this.timers.delete(id)
    if (had) {
      this.h.clearTimeout(this.handles.get(id))
      this.handles.delete(id)
      this.h.onChange?.(this.list())
    }
    return had
  }
}
