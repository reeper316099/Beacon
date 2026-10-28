import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join, sep } from 'node:path'
import chokidar from 'chokidar'
import { searchLean } from '@beacon/matcher'
import type { Action, ParsedQuery, ProviderContext, ResultItem } from '@beacon/shared'
import { LiveProvider, item, copyAction, spawnArgv } from './base'
import { terminalHere, type TerminalConfig } from './terminal'

// ---------- ignore rules ----------

export const DEFAULT_IGNORE_NAMES = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.npm',
  '.cargo',
  '.rustup',
  '.gradle',
  '.m2',
  '.venv',
  '__pycache__',
  '.Trash',
  '.DS_Store',
  'Library',
  'AppData',
  '$RECYCLE.BIN',
  'System Volume Information',
  '.Spotlight-V100',
  '.fseventsd',
  'proc',
  'sys',
  'dev',
  'snap',
  '.local',
  '.vscode-server',
  'Caches',
  'Cache',
]

export interface IgnoreRules {
  names: Set<string>
  /** Case-sensitive glob-ish patterns matched against the entry name (`*.tmp`). */
  globs: RegExp[]
}

export function makeIgnore(
  names: string[] = DEFAULT_IGNORE_NAMES,
  globs: string[] = [],
): IgnoreRules {
  return {
    names: new Set(names),
    globs: globs.map(
      (g) =>
        new RegExp(
          '^' +
            g
              .replace(/[.+^${}()|[\]\\]/g, '\\$&')
              .replace(/\*/g, '.*')
              .replace(/\?/g, '.') +
            '$',
        ),
    ),
  }
}

export function isIgnored(name: string, rules: IgnoreRules): boolean {
  return rules.names.has(name) || rules.globs.some((g) => g.test(name))
}

/** Very small .gitignore reader: name, dir/, *.ext and /anchored lines. Negations are not supported. */
export function parseGitignore(text: string): IgnoreRules {
  const names: string[] = []
  const globs: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim()
    if (!l || l.startsWith('#') || l.startsWith('!')) continue
    const p = l.replace(/^\//, '').replace(/\/$/, '')
    if (p.includes('/')) continue
    ;(/[*?]/.test(p) ? globs : names).push(p)
  }
  return makeIgnore(names, globs)
}

// ---------- crawl ----------

export interface CrawlOptions {
  roots: string[]
  ignore: IgnoreRules
  maxFiles: number
  gitignore?: boolean
  /** Directories read at once. Default 4. */
  concurrency?: number
  /** Yield to the event loop after this many entries (keeps the crawl low priority). */
  yieldEvery?: number
  signal?: AbortSignal
  onProgress?: (scanned: number) => void
}

export interface FileEntry {
  path: string
  isDir: boolean
}

/**
 * Breadth-first, throttled, cancellable crawl. Symlinks are not followed. A few directories are read
 * concurrently so one slow directory (e.g. a macOS permission prompt, a network mount) cannot stall the rest.
 */
export async function crawl(o: CrawlOptions): Promise<FileEntry[]> {
  const out: FileEntry[] = []
  const queue: { dir: string; extra?: IgnoreRules }[] = o.roots.map((dir) => ({ dir }))
  const every = o.yieldEvery ?? 500
  const workers = o.concurrency ?? 4
  let n = 0
  let active = 0

  const readDir = async (job: { dir: string; extra?: IgnoreRules }): Promise<void> => {
    let handle
    try {
      handle = await fs.opendir(job.dir)
    } catch {
      return
    }
    let local = job.extra
    if (o.gitignore) {
      try {
        const g = parseGitignore(await fs.readFile(join(job.dir, '.gitignore'), 'utf8'))
        local = {
          names: new Set([...(job.extra?.names ?? []), ...g.names]),
          globs: [...(job.extra?.globs ?? []), ...g.globs],
        }
      } catch {
        /* no .gitignore */
      }
    }
    for await (const ent of handle) {
      if (o.signal?.aborted || out.length >= o.maxFiles) break
      if (isIgnored(ent.name, o.ignore) || (local && isIgnored(ent.name, local))) continue
      if (ent.name.startsWith('.') && ent.name !== '.config') continue // hidden files are noise for launching
      const path = join(job.dir, ent.name)
      if (ent.isDirectory()) {
        out.push({ path, isDir: true })
        queue.push({ dir: path, ...(local ? { extra: local } : {}) })
      } else if (ent.isFile()) out.push({ path, isDir: false })
      if (++n % every === 0) {
        o.onProgress?.(n)
        await new Promise((r) => setImmediate(r)) // low priority: let searches run
      }
    }
  }

  await new Promise<void>((done) => {
    const pump = (): void => {
      if (o.signal?.aborted || out.length >= o.maxFiles) queue.length = 0
      while (active < workers && queue.length) {
        active++
        void readDir(queue.shift() as { dir: string; extra?: IgnoreRules }).finally(() => {
          active--
          pump()
        })
      }
      if (active === 0 && queue.length === 0) done()
    }
    pump()
  })
  o.onProgress?.(n)
  return out
}

// ---------- built-in index ----------

export class FileIndex {
  /** Parallel arrays: full path, basename (what we match against), directory flag. */
  paths: string[] = []
  names: string[] = []
  dirs: boolean[] = []
  scanning = false
  scanned = 0
  private ctl: AbortController | undefined

  get size(): number {
    return this.paths.length
  }

  set(entries: FileEntry[]): void {
    // Re-materialize paths from one flat blob: split() yields cheap slices of it, which drops the
    // per-path rope/intermediate strings the crawl created (~5x less retained memory).
    this.paths = entries
      .map((e) => e.path)
      .join('\n')
      .split('\n')
    this.names = this.paths.map((p) => basename(p))
    this.dirs = entries.map((e) => e.isDir)
  }

  add(path: string, isDir: boolean): void {
    if (this.paths.includes(path)) return
    this.paths.push(path)
    this.names.push(basename(path))
    this.dirs.push(isDir)
  }

  remove(path: string): void {
    const i = this.paths.indexOf(path)
    if (i < 0) return
    this.paths.splice(i, 1)
    this.names.splice(i, 1)
    this.dirs.splice(i, 1)
  }

  async rebuildFromDisk(o: Omit<CrawlOptions, 'signal' | 'onProgress'>): Promise<void> {
    this.ctl?.abort()
    const ctl = (this.ctl = new AbortController())
    this.scanning = true
    this.scanned = 0
    try {
      const entries = await crawl({
        ...o,
        signal: ctl.signal,
        onProgress: (n) => (this.scanned = n),
      })
      if (!ctl.signal.aborted) this.set(entries)
    } finally {
      if (this.ctl === ctl) this.scanning = false
    }
  }

  cancel(): void {
    this.ctl?.abort()
  }

  /** Time-boxed so a very large index cannot hold the worker thread. */
  search(text: string, limit: number, budgetMs = 60): { index: number; score: number }[] {
    return searchLean(this.names, text, limit, budgetMs)
  }

  async save(file: string): Promise<void> {
    await fs.mkdir(dirname(file), { recursive: true })
    const lines = this.paths.map((p, i) => (this.dirs[i] ? 'd' : 'f') + p)
    await fs.writeFile(file, lines.join('\n'))
  }

  async load(file: string): Promise<boolean> {
    try {
      const text = await fs.readFile(file, 'utf8')
      this.set(
        text
          .split('\n')
          .filter(Boolean)
          .map((l) => ({ isDir: l[0] === 'd', path: l.slice(1) })),
      )
      return true
    } catch {
      return false
    }
  }
}

/**
 * Incremental updates: watch roots (and the usual download/desktop/documents folders under them)
 * and apply add/unlink events. Deliberately shallow: recursive watches over a whole home dir cost
 * ~100 MB; deeper changes are picked up by the periodic rebuild.
 */
export function watchFiles(
  idx: FileIndex,
  roots: string[],
  ignore: IgnoreRules,
): () => Promise<void> {
  const common = roots.flatMap((r) => ['Desktop', 'Documents', 'Downloads'].map((d) => join(r, d)))
  const w = chokidar.watch([...roots, ...common], {
    ignoreInitial: true,
    depth: 1,
    ignored: (p) =>
      p
        .split(sep)
        .some(
          (seg) =>
            isIgnored(seg, ignore) || (seg.startsWith('.') && seg.length > 1 && seg !== '.config'),
        ),
  })
  w.on('add', (p) => idx.add(p, false))
  w.on('addDir', (p) => idx.add(p, true))
  w.on('unlink', (p) => idx.remove(p))
  w.on('unlinkDir', (p) => idx.remove(p))
  w.on('error', () => {})
  return () => w.close()
}

// ---------- external sources ----------

export interface FileSource {
  id: string
  available(): Promise<boolean>
  search(text: string, limit: number, signal: AbortSignal): Promise<string[]>
}

export type Exec = (file: string, args: string[], signal: AbortSignal) => Promise<string>

export const realExec: Exec = (file, args, signal) =>
  new Promise((res, rej) =>
    execFile(
      file,
      args,
      { maxBuffer: 8 << 20, timeout: 3000, signal, windowsHide: true },
      (e, out) => (e ? rej(e) : res(out)),
    ),
  )

const lines = (s: string) => s.split(/\r?\n/).filter((l) => l.trim())

async function which(bin: string): Promise<boolean> {
  for (const d of (process.env['PATH'] ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    for (const ext of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      try {
        await fs.access(join(d, bin + ext))
        return true
      } catch {
        /* next */
      }
    }
  }
  return false
}

/** macOS Spotlight. The text is passed as one argv element to `-name`, never interpreted as a query. */
export const mdfindSource = (exec: Exec = realExec): FileSource => ({
  id: 'spotlight',
  available: async () => process.platform === 'darwin',
  search: async (text, limit, signal) =>
    lines(await exec('mdfind', ['-name', text], signal)).slice(0, limit),
})

/** Windows: Everything's es.exe. */
export const everythingSource = (exec: Exec = realExec, bin = 'es.exe'): FileSource => ({
  id: 'everything',
  available: () => which(bin.replace(/\.exe$/, '')),
  search: async (text, limit, signal) =>
    lines(await exec(bin, ['-n', String(limit), text], signal)),
})

/** Linux: plocate (preferred) or locate, basename match. */
export const locateSource = (exec: Exec = realExec, bin = 'plocate'): FileSource => ({
  id: 'locate',
  available: async () => (await which('plocate')) || (await which('locate')),
  search: async (text, limit, signal) =>
    lines(await exec(bin, ['-i', '-b', '-l', String(limit), '--', text], signal)),
})

// ---------- provider ----------

export interface FilesConfig {
  source: 'builtin' | 'spotlight' | 'everything' | 'locate'
  roots: string[]
  maxFiles: number
  gitignore: boolean
  ignoreNames: string[]
  ignoreGlobs: string[]
}

export function applyFilters(
  paths: { path: string; isDir: boolean }[],
  f: Record<string, string>,
): typeof paths {
  return paths.filter(({ path, isDir }) => {
    if (
      f['ext'] &&
      extname(path).slice(1).toLowerCase() !== f['ext'].replace(/^\./, '').toLowerCase()
    )
      return false
    if (f['in'] && !path.toLowerCase().includes(f['in'].toLowerCase())) return false
    if (f['type']) {
      const t = f['type'].toLowerCase()
      if ((t === 'folder' || t === 'dir') && !isDir) return false
      if (t === 'file' && isDir) return false
    }
    return true
  })
}

const TEXT_EXT = new Set([
  '.txt',
  '.md',
  '.json',
  '.js',
  '.ts',
  '.tsx',
  '.py',
  '.sh',
  '.yml',
  '.yaml',
  '.toml',
  '.csv',
  '.log',
  '.html',
  '.css',
  '.rs',
  '.go',
  '.c',
  '.h',
  '.cpp',
  '.java',
  '.rb',
  '.conf',
  '.ini',
  '.xml',
])

/** Short text preview for small text files; null otherwise. */
export async function textPreview(path: string, maxBytes = 2048): Promise<string | null> {
  if (!TEXT_EXT.has(extname(path).toLowerCase())) return null
  try {
    const st = await fs.stat(path)
    if (!st.isFile() || st.size > 512 * 1024) return null
    const fh = await fs.open(path, 'r')
    try {
      const buf = Buffer.alloc(Math.min(maxBytes, st.size))
      await fh.read(buf, 0, buf.length, 0)
      const text = buf.toString('utf8')
      return text.includes('\u0000') ? null : text
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

export class FilesProvider extends LiveProvider {
  id = 'files'
  name = 'Files & folders'
  weight = 0.8
  triggers = ['f ', 'file ']
  constructor(
    readonly index: FileIndex,
    private cfg: () => FilesConfig,
    private sources: Record<string, FileSource> = {},
    private terminal: () => TerminalConfig = () => ({}),
  ) {
    super()
  }

  protected async compute(
    q: ParsedQuery,
    _ctx: ProviderContext,
    signal: AbortSignal,
  ): Promise<ResultItem[]> {
    const text = q.text
    if (!text || (!q.trigger && text.length < 3)) return []
    const cfg = this.cfg()
    let hits: { path: string; isDir: boolean; score: number }[]
    const src = cfg.source !== 'builtin' ? this.sources[cfg.source] : undefined
    if (src && (await src.available())) {
      const paths = await src.search(text, 100, signal).catch(() => [] as string[])
      const stats = await Promise.all(
        paths.map((p) =>
          fs.stat(p).then(
            (s) => s.isDirectory(),
            () => false,
          ),
        ),
      )
      hits = paths.map((path, i) => ({ path, isDir: stats[i] as boolean, score: 200 - i }))
    } else {
      hits = this.index.search(text, 100).map((r) => ({
        path: this.index.paths[r.index] as string,
        isDir: this.index.dirs[r.index] as boolean,
        score: r.score,
      }))
    }
    const filtered = applyFilters(hits, q.filters) as typeof hits
    const top = filtered.slice(0, 40)
    return Promise.all(
      top.map(async (h, i) => {
        const dir = h.isDir ? h.path : dirname(h.path)
        const prev = i < 5 && !h.isDir ? await textPreview(h.path) : null
        const actions: Action[] = [
          {
            id: 'reveal',
            title: 'Reveal in file manager',
            kind: 'reveal',
            payload: { path: h.path },
          },
          copyAction(h.path, 'Copy path'),
          { id: 'terminal', title: 'Open terminal here', kind: 'custom', payload: { dir } },
        ]
        return item(this.id, {
          id: h.path,
          title: basename(h.path),
          subtitle: dirname(h.path),
          kind: h.isDir ? 'folder' : 'file',
          score: h.score,
          primary: { id: 'open', title: 'Open', kind: 'open', payload: { path: h.path } },
          actions,
          ...(prev ? { preview: { type: 'text' as const, value: prev } } : {}),
        })
      }),
    )
  }

  protected async custom(a: Action): Promise<void> {
    const dir = (a.payload as { dir?: string }).dir
    if (a.id === 'terminal' && dir)
      await spawnArgv(terminalHere(process.platform, dir, this.terminal()))
  }
}
