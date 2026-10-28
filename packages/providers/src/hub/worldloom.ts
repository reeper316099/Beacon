import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { deepLink, type HubItem, type LoadResult, type SourceAdapter } from './types'
import { frontmatter, listDirs, listFiles, readJson, str, strs } from './util'

// ---- reveal logic: a faithful port of Worldloom's gate rules (conservative: unknown = hidden) ----
type Reveal = { sourceId: string; at: number } | { arcId: string }
interface Arc {
  id: string
  order: number
  ranges: Record<string, { from: number; to: number }>
}
interface Progress {
  sources: Record<string, number>
  arcCheckpoint?: string
  impliedFloor: 'conservative' | 'full'
}
interface Ctx {
  progress: Progress
  arcs: Arc[]
  primarySourceIds: Set<string>
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

function parseReveal(v: unknown): Reveal | 'invalid' | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o['sourceId'] === 'string' && num(o['at']) !== undefined)
      return { sourceId: o['sourceId'], at: o['at'] as number }
    if (typeof o['arcId'] === 'string') return { arcId: o['arcId'] }
  }
  return 'invalid' // a gate we can't understand is treated as closed
}

function effective(ctx: Ctx): Record<string, number> {
  const out = { ...ctx.progress.sources }
  const cp = ctx.progress.arcCheckpoint
    ? ctx.arcs.find((a) => a.id === ctx.progress.arcCheckpoint)
    : undefined
  if (!cp) return out
  for (const [sid, range] of Object.entries(cp.ranges)) {
    const floor =
      ctx.progress.impliedFloor === 'full' || ctx.primarySourceIds.has(sid) ? range.to : range.from
    out[sid] = Math.max(out[sid] ?? -Infinity, floor)
  }
  return out
}

export function revealSatisfied(r: Reveal | 'invalid', ctx: Ctx): boolean {
  if (r === 'invalid') return false
  const eff = effective(ctx)
  if ('sourceId' in r) return eff[r.sourceId] !== undefined && (eff[r.sourceId] as number) >= r.at
  const arc = ctx.arcs.find((a) => a.id === r.arcId)
  if (!arc) return false
  const cp = ctx.progress.arcCheckpoint
    ? ctx.arcs.find((a) => a.id === ctx.progress.arcCheckpoint)
    : undefined
  if (cp && cp.order >= arc.order) return true
  return Object.entries(arc.ranges).some(
    ([sid, range]) => eff[sid] !== undefined && (eff[sid] as number) >= range.from,
  )
}

/**
 * Worldloom (read-only, spoiler-safe by default). A page is included only if it has no gate, or its
 * gate is satisfied by the world's saved progress. Gated pages are never read into the result: their
 * titles, aliases and bodies cannot leak. Page bodies are never included at all.
 * Not honoured on purpose: the app's own `showAll` and per-item `revealed` lists (Beacon has its own
 * explicit `showSpoilers` switch), DM-only pages, redirect pages.
 */
export const worldloom: SourceAdapter = {
  contractVersion: 1,
  id: 'worldloom',
  name: 'Worldloom',
  scheme: 'worldloom',
  triggers: ['wl ', 'wiki '],
  dataDirEnv: 'WORLDLOOM_DATA_DIR',
  folderName: 'Worldloom',

  async load(dir, opts): Promise<LoadResult> {
    const items: HubItem[] = []
    const warnings: string[] = []
    for (const slug of await listDirs(join(dir, 'worlds'))) {
      const wdir = join(dir, 'worlds', slug)
      const w = await readJson(join(wdir, 'world.json'))
      if (!w.ok || !w.value || typeof w.value !== 'object') {
        warnings.push(
          `skipped world "${slug}" (world.json ${w.ok ? 'invalid' : w.reason}); progress unknown so nothing is shown`,
        )
        continue
      }
      const world = w.value as Record<string, unknown>
      const sources = (Array.isArray(world['sources']) ? world['sources'] : []) as {
        id?: string
        continuityId?: string
      }[]
      const continuities = (Array.isArray(world['continuities']) ? world['continuities'] : []) as {
        id?: string
        isPrimary?: boolean
      }[]
      const primaryConts = new Set(
        continuities.filter((c) => c.isPrimary && c.id).map((c) => c.id as string),
      )
      const prog = (world['progress'] ?? {}) as Record<string, unknown>
      const rawSources = (prog['sources'] ?? {}) as Record<string, unknown>
      const ctx: Ctx = {
        progress: {
          sources: Object.fromEntries(
            Object.entries(rawSources)
              .filter(([, v]) => num(v) !== undefined)
              .map(([k, v]) => [k, v as number]),
          ),
          ...(typeof prog['arcCheckpoint'] === 'string'
            ? { arcCheckpoint: prog['arcCheckpoint'] }
            : {}),
          impliedFloor: prog['impliedFloor'] === 'full' ? 'full' : 'conservative',
        },
        arcs: (Array.isArray(world['arcs']) ? world['arcs'] : []).flatMap(
          (a: Record<string, unknown>) =>
            typeof a?.['id'] === 'string' && num(a['order']) !== undefined
              ? [
                  {
                    id: a['id'],
                    order: a['order'] as number,
                    ranges: (a['ranges'] ?? {}) as Arc['ranges'],
                  },
                ]
              : [],
        ),
        primarySourceIds: new Set(
          sources
            .filter((s) => s.id && s.continuityId && primaryConts.has(s.continuityId))
            .map((s) => s.id as string),
        ),
      }
      const worldName = str(world['name']) ?? slug

      for (const file of await listFiles(join(wdir, 'pages'), '.md')) {
        let text: string
        try {
          text = await fs.readFile(file, 'utf8')
        } catch {
          continue
        }
        const fm = frontmatter(text)
        if (!fm) {
          warnings.push(`skipped a page in "${slug}" (unreadable frontmatter)`)
          continue
        }
        const d = fm.data
        const id = str(d['id'])
        const title = str(d['title'])
        const pageSlug = str(d['slug']) ?? file.split('/').pop()?.replace(/\.md$/, '')
        if (!id || !title || !pageSlug) continue
        if (d['dmOnly'] === true || d['redirectsTo']) continue
        if (!opts.showSpoilers) {
          const gate = parseReveal(d['reveal'])
          if (gate !== undefined && !revealSatisfied(gate, ctx)) continue
        }
        items.push({
          id: `wl:${slug}:${id}`,
          title,
          subtitle: `${worldName} · ${str(d['type']) ?? 'page'}`,
          kind: 'worldloom',
          keywords: strs(d['aliases']),
          primary: {
            id: 'open',
            title: 'Open in Worldloom',
            kind: 'deeplink',
            payload: { url: deepLink('worldloom', 'open', { world: slug, page: pageSlug }) },
          },
        })
      }
    }
    return { items, warnings }
  },
}
