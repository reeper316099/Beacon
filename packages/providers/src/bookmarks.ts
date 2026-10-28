import { promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonFile } from '@beacon/jsonstore'
import { FuzzyIndex } from '@beacon/matcher'
import type { Action, ParsedQuery, ResultItem } from '@beacon/shared'
import { LiveProvider, item, copyAction } from './base'

export interface Bookmark {
  title: string
  url: string
  folder?: string
}

export interface BookmarkProfile {
  /** e.g. "chrome:Default" */
  id: string
  label: string
  kind: 'chromium' | 'firefox'
  /** Path to the Bookmarks JSON or places.sqlite. */
  file: string
}

// ---------- Chromium family ----------

interface CNode {
  type?: string
  name?: string
  url?: string
  children?: CNode[]
}

export function parseChromiumBookmarks(json: string): Bookmark[] {
  let root: { roots?: Record<string, CNode> }
  try {
    root = JSON.parse(json)
  } catch {
    return []
  }
  const out: Bookmark[] = []
  const walk = (n: CNode, folder: string) => {
    if (n.type === 'url' && n.url && n.name !== undefined)
      out.push({ title: n.name, url: n.url, ...(folder ? { folder } : {}) })
    for (const c of n.children ?? [])
      walk(c, n.type === 'folder' && n.name ? (folder ? folder + '/' : '') + n.name : folder)
  }
  for (const r of Object.values(root.roots ?? {})) if (r && typeof r === 'object') walk(r, '')
  return out
}

// ---------- Firefox ----------

type SqlJs = {
  Database: new (data: Uint8Array) => {
    exec(sql: string): { values: unknown[][] }[]
    close(): void
  }
}
let sqlJs: Promise<SqlJs> | undefined
async function loadSql(): Promise<SqlJs> {
  sqlJs ??= (async () => {
    const init = (await import('sql.js')).default as unknown as (cfg?: object) => Promise<SqlJs>
    return init()
  })()
  return sqlJs
}

/** Read bookmarks from a Firefox places.sqlite. The live DB is locked, so a copy is read (pure WASM sqlite). */
export async function readFirefoxBookmarks(placesFile: string): Promise<Bookmark[]> {
  const tmp = await fs.mkdtemp(join(tmpdir(), 'beacon-ff-'))
  try {
    const copy = join(tmp, 'places.sqlite')
    await fs.copyFile(placesFile, copy)
    const SQL = await loadSql()
    const db = new SQL.Database(await fs.readFile(copy))
    try {
      const res = db.exec(
        `SELECT b.title, p.url FROM moz_bookmarks b JOIN moz_places p ON b.fk = p.id
         WHERE b.type = 1 AND p.url LIKE 'http%' AND b.title IS NOT NULL`,
      )
      return (res[0]?.values ?? []).map((r) => ({ title: String(r[0]), url: String(r[1]) }))
    } finally {
      db.close()
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

// ---------- discovery ----------

const CHROMIUM_DIRS: Record<string, [string, string][]> = {
  darwin: [
    ['chrome', 'Library/Application Support/Google/Chrome'],
    ['edge', 'Library/Application Support/Microsoft Edge'],
    ['brave', 'Library/Application Support/BraveSoftware/Brave-Browser'],
    ['vivaldi', 'Library/Application Support/Vivaldi'],
  ],
  win32: [
    ['chrome', 'AppData/Local/Google/Chrome/User Data'],
    ['edge', 'AppData/Local/Microsoft/Edge/User Data'],
    ['brave', 'AppData/Local/BraveSoftware/Brave-Browser/User Data'],
    ['vivaldi', 'AppData/Local/Vivaldi/User Data'],
  ],
  linux: [
    ['chrome', '.config/google-chrome'],
    ['chromium', '.config/chromium'],
    ['edge', '.config/microsoft-edge'],
    ['brave', '.config/BraveSoftware/Brave-Browser'],
    ['vivaldi', '.config/vivaldi'],
  ],
}

const FIREFOX_DIRS: Record<string, string[]> = {
  darwin: ['Library/Application Support/Firefox/Profiles'],
  win32: ['AppData/Roaming/Mozilla/Firefox/Profiles'],
  linux: [
    '.mozilla/firefox',
    'snap/firefox/common/.mozilla/firefox',
    '.var/app/org.mozilla.firefox/.mozilla/firefox',
  ],
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  )
}

export async function discoverBookmarkProfiles(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): Promise<BookmarkProfile[]> {
  const out: BookmarkProfile[] = []
  for (const [browser, rel] of CHROMIUM_DIRS[platform] ?? []) {
    const base = join(home, rel)
    let names: string[] = []
    try {
      names = await fs.readdir(base)
    } catch {
      continue
    }
    for (const n of names.filter((n) => n === 'Default' || /^Profile \d+$/.test(n)).sort()) {
      const file = join(base, n, 'Bookmarks')
      if (await exists(file))
        out.push({
          id: `${browser}:${n}`,
          label: `${browser[0]!.toUpperCase()}${browser.slice(1)} — ${n}`,
          kind: 'chromium',
          file,
        })
    }
  }
  for (const rel of FIREFOX_DIRS[platform] ?? []) {
    const base = join(home, rel)
    let names: string[] = []
    try {
      names = await fs.readdir(base)
    } catch {
      continue
    }
    for (const n of names.sort()) {
      const file = join(base, n, 'places.sqlite')
      if (await exists(file))
        out.push({ id: `firefox:${n}`, label: `Firefox — ${n}`, kind: 'firefox', file })
    }
  }
  return out
}

export async function loadProfile(p: BookmarkProfile): Promise<Bookmark[]> {
  return p.kind === 'chromium'
    ? parseChromiumBookmarks(await fs.readFile(p.file, 'utf8'))
    : readFirefoxBookmarks(p.file)
}

// ---------- provider ----------

export interface BookmarkConfig {
  /** Profile ids the user opted into. Nothing is read until a profile is enabled. */
  enabled: string[]
}

const httpOnly = (u: string) => /^https?:\/\//i.test(u)

export class BookmarksProvider extends LiveProvider {
  id = 'bookmarks'
  name = 'Bookmarks'
  mode = 'prefix-only' as const
  triggers = ['bm ', 'bm']
  private bmCache = new Map<string, { at: number; list: Bookmark[] }>()
  constructor(
    private cfg: JsonFile<BookmarkConfig>,
    private discover: () => Promise<BookmarkProfile[]> = () => discoverBookmarkProfiles(),
    private load: (p: BookmarkProfile) => Promise<Bookmark[]> = loadProfile,
    private ttlMs = 60_000,
  ) {
    super()
  }

  private async bookmarks(p: BookmarkProfile): Promise<Bookmark[]> {
    const hit = this.bmCache.get(p.id)
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.list
    const list = (await this.load(p).catch(() => [])).filter((b) => httpOnly(b.url))
    this.bmCache.set(p.id, { at: Date.now(), list })
    return list
  }

  protected async compute(q: ParsedQuery): Promise<ResultItem[]> {
    const profiles = await this.discover()
    const enabled = new Set(this.cfg.data.enabled)
    const on = profiles.filter((p) => enabled.has(p.id))
    const setup = profiles
      .filter((p) => !enabled.has(p.id))
      .map((p) =>
        item(this.id, {
          id: 'enable:' + p.id,
          title: `Enable bookmarks from ${p.label}`,
          subtitle: 'Reads this browser profile’s bookmarks locally. No history.',
          kind: 'bookmarks',
          score: on.length ? 50 : 800,
          primary: { id: 'enable', title: 'Enable', kind: 'custom', payload: { id: p.id } },
        }),
      )
    if (!on.length) return setup
    const all: (Bookmark & { src: string })[] = []
    for (const p of on) for (const b of await this.bookmarks(p)) all.push({ ...b, src: p.label })
    const hits = q.text
      ? new FuzzyIndex(all.map((b) => [`${b.title} ${b.url}`, b] as const))
          .search(q.text, 30)
          .map((r) => r.item)
      : all.slice(0, 30)
    return [
      ...hits.map((b, i) =>
        item(this.id, {
          id: b.url,
          title: b.title || b.url,
          subtitle: b.url,
          kind: 'bookmark',
          score: 500 - i,
          primary: { id: 'open', title: 'Open in browser', kind: 'url', payload: { url: b.url } },
          actions: [copyAction(b.url, 'Copy URL')],
        }),
      ),
      ...setup,
    ]
  }

  protected async custom(a: Action): Promise<void> {
    const id = (a.payload as { id?: string }).id
    if (a.id === 'enable' && id)
      await this.cfg.update((d) => ({ enabled: [...new Set([...d.enabled, id])] }))
  }
}
