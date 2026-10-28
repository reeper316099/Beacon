// Search worker (Electron utilityProcess). Owns indexes, frecency and providers; talks to the
// renderer directly over a MessagePort so the hot path never touches the main process.
import { execFile, fork, type ChildProcess } from 'node:child_process'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  AliasProvider,
  BookmarksProvider,
  DEFAULT_IGNORE_NAMES,
  FileIndex,
  FilesProvider,
  SshProvider,
  everythingSource,
  locateSource,
  makeIgnore,
  mdfindSource,
  watchFiles,
  type FilesConfig,
  type BookmarkConfig,
  type TerminalConfig,
  BindProvider,
  CalculatorProvider,
  ClipboardProvider,
  ClipboardStore,
  NotesProvider,
  PinStore,
  PinsProvider,
  SnippetProvider,
  TodoProvider,
  type AliasMap,
  type Note,
  type Snippet,
  type Todo,
  ColorProvider,
  DEFAULT_QUICKLINKS,
  DevProvider,
  EmojiProvider,
  ProcessProvider,
  QuicklinkProvider,
  SystemProvider,
  TimerProvider,
  TimerStore,
  type Quicklink,
  type TimerRec,
} from '@beacon/providers'
import {
  type Platform,
  discoverApps,
  watchRoots,
  AppsProvider,
  discoverMac,
  discoverWindows,
  discoverLinux,
  macAppDirs,
  winStartMenuDirs,
  linuxAppDirs,
} from '@beacon/apps'
import { Frecency, SearchEngine, attachSearchService, type FrecencyData } from '@beacon/core'
import { JsonFile } from '@beacon/jsonstore'
import type { Effects, ParsedQuery, Provider, ResultItem } from '@beacon/shared'

// utilityProcess ignores --expose-gc, so obtain gc() via V8 flags. Used to hand crawl garbage back
// right after indexing (idle memory is a requirement).
let gcFn: (() => void) | undefined
try {
  setFlagsFromString('--expose-gc')
  gcFn = runInNewContext('gc') as () => void
} catch {
  /* optional */
}

const parentPort = (process as unknown as { parentPort: Electron.ParentPort }).parentPort

// Side effects (clipboard, browser, notifications) are performed by the main process.
let clip: ClipboardStore | undefined
let rebuildFilesHook: (() => Promise<void>) | undefined
let rid = 0
const waiting = new Map<number, (v: string) => void>()
function effect(kind: string, payload: unknown, wantReply = false): Promise<string> {
  const id = ++rid
  parentPort.postMessage({ type: 'effect', kind, payload, rid: id })
  return wantReply ? new Promise((res) => waiting.set(id, res)) : Promise.resolve('')
}
const effects: Effects = {
  copy: async (text) => void (await effect('copy', text)),
  openUrl: async (url) => void (await effect('openUrl', url)),
  notify: async (title, body) => void (await effect('notify', { title, body })),
  readClipboard: () => effect('readClipboard', null, true),
  copyImage: async (hash) => void (await effect('copyImage', hash)),
  openPath: async (path) => void (await effect('openPath', path)),
  reveal: async (path) => void (await effect('reveal', path)),
  bindHotkey: async (accelerator, providerId, itemId, title) =>
    void (await effect('bindHotkey', { accelerator, providerId, itemId, title })),
}

const quicklinkSchema = z.array(
  z.object({ keyword: z.string().min(1), name: z.string(), url: z.string() }),
)
const timersSchema = z.array(
  z.object({ id: z.string(), label: z.string(), endsAt: z.number(), startedAt: z.number() }),
)
const snippetsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    body: z.string(),
    tags: z.array(z.string()),
    folder: z.string(),
  }),
)
const notesSchema = z.array(z.object({ id: z.string(), text: z.string(), ts: z.number() }))
const todosSchema = z.array(
  z.object({
    id: z.string(),
    text: z.string(),
    done: z.boolean(),
    due: z.string().optional(),
    ts: z.number(),
  }),
)
const pinsSchema = z.array(z.any())
const aliasSchema = z.record(z.any())
const clipConfigSchema = z.object({
  retentionDays: z.number().positive().default(7),
  maxItems: z.number().int().positive().default(500),
  /** Regexes (strings); copies matching any are never stored. */
  ignore: z.array(z.string()).default([]),
})
const filesConfigSchema = z.object({
  source: z.enum(['builtin', 'spotlight', 'everything', 'locate']).default('builtin'),
  roots: z.array(z.string()).default(() => [homedir()]),
  maxFiles: z.number().int().positive().default(100_000),
  gitignore: z.boolean().default(false),
  ignoreNames: z.array(z.string()).default([]),
  ignoreGlobs: z.array(z.string()).default([]),
})
const terminalSchema = z.object({ command: z.array(z.string()).optional() })
const bookmarkSchema = z.object({ enabled: z.array(z.string()).default([]) })
const ratesSchema = z.record(z.number().positive())

const frecencySchema = z.record(z.record(z.object({ v: z.number(), ts: z.number() })))

function exec(file: string, args: string[]): Promise<string | undefined> {
  return new Promise((res) =>
    execFile(file, args, { timeout: 15_000, maxBuffer: 16 << 20, windowsHide: true }, (e, out) =>
      res(e ? undefined : out),
    ),
  )
}

/** Empty-query state: most frecent apps. */
class RecentsProvider implements Provider {
  id = 'recents'
  name = 'Recent'
  mode = 'global' as const
  constructor(
    private apps: AppsProvider,
    private frecency: Frecency,
  ) {}
  async query(q: ParsedQuery): Promise<ResultItem[]> {
    if (q.text) return []
    const out: ResultItem[] = []
    for (const { key, score } of this.frecency.top(8)) {
      const a = this.apps.byId.get(key)
      if (!a) continue
      const r: ResultItem = {
        id: a.id,
        providerId: this.apps.id,
        title: a.name,
        kind: 'app',
        score: 100 + score,
        primary: { id: 'launch', title: 'Open', kind: 'open', payload: null },
        actions: a.actions.map((x) => ({
          id: x.id,
          title: x.title,
          kind: 'custom',
          payload: null,
        })),
      }
      if (a.iconPath) r.icon = a.iconPath
      out.push(r)
    }
    return out
  }
}

const dbg = (label: string) => {
  if (!process.env['BEACON_DEBUG_MEM']) return
  gcFn?.()
  console.log(
    'WORKERMEM',
    label,
    'gc=' + typeof gcFn,
    Math.round(process.memoryUsage().heapUsed / 1e6) + 'MB heap',
    Math.round(process.memoryUsage().rss / 1e6) + 'MB rss',
  )
}

async function main(dataDir: string, cacheDir: string, clipPaused: boolean): Promise<void> {
  dbg('start')
  const store = new JsonFile<FrecencyData>({
    path: join(dataDir, 'data/frecency/frecency.json'),
    schema: frecencySchema,
    defaults: () => ({}),
    version: 1,
  })
  const frecency = new Frecency({}, await store.load())
  const engine = new SearchEngine({ frecency, timeoutMs: 250, ctx: { now: Date.now, effects } })

  // User config (hand-editable JSON; invalid edits are quarantined, defaults used).
  const linksFile = new JsonFile<Quicklink[]>({
    path: join(dataDir, 'config/quicklinks.json'),
    schema: quicklinkSchema,
    defaults: () => DEFAULT_QUICKLINKS,
  })
  const ratesFile = new JsonFile<Record<string, number>>({
    path: join(dataDir, 'config/rates.json'),
    schema: ratesSchema,
    defaults: () => ({}),
  })
  const timersFile = new JsonFile<TimerRec[]>({
    path: join(dataDir, 'data/timers.json'),
    schema: timersSchema,
    defaults: () => [],
  })
  const timers = new TimerStore({
    now: Date.now,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    onFire: (t) => void effects.notify(t.label, 'Timer finished'),
    onChange: (all) => void timersFile.set(all).catch(() => {}),
  })
  timers.restore(await timersFile.load())
  const links = new QuicklinkProvider(await linksFile.load())
  const rates = await ratesFile.load()

  const apps = new AppsProvider()
  engine.register(apps)

  const file = <T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, defaults: () => T) =>
    new JsonFile<T>({ path: join(dataDir, path), schema, defaults })
  const snippets = file<Snippet[]>('data/snippets/snippets.json', snippetsSchema, () => [])
  const notes = file<Note[]>('data/notes/notes.json', notesSchema, () => [])
  const todos = file<Todo[]>('data/todos/todos.json', todosSchema, () => [])
  const pinFile = file<ResultItem[]>('data/pins.json', pinsSchema, () => [])
  const aliasFile = file<AliasMap>('config/aliases.json', aliasSchema, () => ({}))
  const clipCfg = await file('config/clipboard.json', clipConfigSchema, () =>
    clipConfigSchema.parse({}),
  ).load()
  await Promise.all([snippets, notes, todos, pinFile, aliasFile].map((f) => f.load()))

  const compileIgnore = (pats: string[]) =>
    pats.flatMap((p) => {
      try {
        return [new RegExp(p)]
      } catch {
        return []
      }
    })
  clip = new ClipboardStore({
    path: join(dataDir, 'data/clipboard/history.jsonl'),
    retentionMs: clipCfg.retentionDays * 86_400_000,
    maxItems: clipCfg.maxItems,
    ignore: compileIgnore(clipCfg.ignore),
  })
  clip.paused = clipPaused
  await clip.load()
  setInterval(() => clip?.prune(), 3_600_000).unref()
  dbg('configs loaded')
  const pins = new PinStore(pinFile)

  // Files: configurable source; the built-in index is crawled in the background, throttled and cancellable.
  const filesCfg = await file<FilesConfig>('config/files.json', filesConfigSchema as never, () =>
    filesConfigSchema.parse({}),
  ).load()
  const termCfg = await file<TerminalConfig>(
    'config/terminal.json',
    terminalSchema as never,
    () => ({}),
  ).load()
  const bmFile = file<BookmarkConfig>('config/bookmarks.json', bookmarkSchema as never, () => ({
    enabled: [],
  }))
  await bmFile.load()
  const fileIndex = new FileIndex()
  const snapshot = join(cacheDir, 'file-index/index.txt')
  const ignore = makeIgnore(
    [...DEFAULT_IGNORE_NAMES, ...filesCfg.ignoreNames],
    filesCfg.ignoreGlobs,
  )
  const reportFiles = () =>
    parentPort.postMessage({
      type: 'files',
      size: fileIndex.size,
      scanning: fileIndex.scanning,
      scanned: fileIndex.scanned,
    })
  const collect = () => gcFn?.()
  let crawlProc: ChildProcess | undefined
  const rebuildFiles = async () => {
    if (filesCfg.source !== 'builtin') return
    crawlProc?.kill() // a newer rebuild supersedes a running one
    fileIndex.scanning = true
    const t = setInterval(reportFiles, 1000)
    try {
      const job = {
        roots: filesCfg.roots,
        ignoreNames: [...DEFAULT_IGNORE_NAMES, ...filesCfg.ignoreNames],
        ignoreGlobs: filesCfg.ignoreGlobs,
        maxFiles: filesCfg.maxFiles,
        gitignore: filesCfg.gitignore,
        out: snapshot,
      }
      const child = (crawlProc = fork(join(__dirname, 'crawlWorker.js'), [JSON.stringify(job)], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }))
      child.on('message', (m: { type: string; n?: number }) => {
        if (m.type === 'progress') fileIndex.scanned = m.n ?? 0
      })
      const ok = await new Promise<boolean>((res) => {
        child.once('message', (m: { type: string }) => m.type === 'done' && res(true))
        child.once('error', () => res(false))
        child.once('exit', (code) => res(code === 0))
      })
      if (ok && crawlProc === child) await fileIndex.load(snapshot)
    } finally {
      clearInterval(t)
      fileIndex.scanning = false
      collect()
      dbg('after index')
      reportFiles()
    }
  }
  if (filesCfg.source === 'builtin') {
    await fileIndex.load(snapshot) // instant results from the last session
    collect()
    void rebuildFiles().then(() => {
      watchFiles(fileIndex, filesCfg.roots, ignore)
      // Periodic low-priority rebuild catches changes the shallow watcher can't see.
      setInterval(() => void rebuildFiles(), 30 * 60_000).unref()
    })
  }
  rebuildFilesHook = rebuildFiles
  dbg('files set up')
  engine.register(new RecentsProvider(apps, frecency))
  // Resolve free text to its best result (used by `alias` / `hotkey` commands).
  const resolve = async (text: string): Promise<ResultItem | undefined> => {
    const skip = new Set(['recents', 'pins', 'aliases', 'alias', 'hotkey', 'todos'])
    let best: ResultItem | undefined
    await engine.search(text, (b) => {
      for (const i of b.items)
        if (!skip.has(i.providerId) && (!best || i.score > best.score)) best = i
    })
    return best
  }
  for (const p of [
    new PinsProvider(pins),
    new FilesProvider(
      fileIndex,
      () => filesCfg,
      { spotlight: mdfindSource(), everything: everythingSource(), locate: locateSource() },
      () => termCfg,
    ),
    new SshProvider(undefined, process.platform, () => termCfg),
    new BookmarksProvider(bmFile),
    new AliasProvider(aliasFile),
    new BindProvider('alias', 'Aliases', aliasFile, resolve),
    new BindProvider('hotkey', 'Hotkeys', aliasFile, resolve),
    new ClipboardProvider(clip, (hashes) => void effect('deleteImages', hashes)),
    new SnippetProvider(snippets),
    new NotesProvider(notes),
    new TodoProvider(todos),
    new CalculatorProvider(() => rates),
    new ColorProvider(),
    new DevProvider(),
    new SystemProvider(),
    links,
    new EmojiProvider(),
    new TimerProvider(timers),
    new ProcessProvider(),
  ])
    engine.register(p)

  // Index apps in the background; search is usable (empty) immediately.
  const t0 = performance.now()
  const plat = process.platform as Platform
  const convertPlist = (p: string) => exec('plutil', ['-convert', 'xml1', '-o', '-', p])
  const getStartApps = () =>
    exec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-StartApps | ConvertTo-Json',
    ])
  void discoverApps(plat, { convertPlist, getStartApps }).then(async (list) => {
    apps.setAll(list)
    parentPort.postMessage({
      type: 'indexed',
      apps: list.length,
      ms: Math.round(performance.now() - t0),
    })
  })

  const roots =
    plat === 'darwin' ? macAppDirs() : plat === 'win32' ? winStartMenuDirs() : linuxAppDirs()
  const rescan = async (root: string) => {
    const list =
      plat === 'darwin'
        ? await discoverMac({ dirs: [root], convertPlist })
        : plat === 'win32'
          ? await discoverWindows({ dirs: [root], getStartApps })
          : await discoverLinux({ dirs: [root] })
    apps.replaceSource(root, list)
  }
  watchRoots(roots, (r) => void rescan(r))

  let last = ''
  setInterval(() => {
    const cur = JSON.stringify(frecency.serialize())
    if (cur === last) return
    last = cur
    void store.set(frecency.serialize()).catch(() => {})
  }, 3000).unref()

  let detach: (() => void) | undefined
  parentPort.on('message', (e) => {
    const m = e.data as {
      type?: string
      rid?: number
      value?: string
      text?: string
      hash?: string
      bytes?: number
      concealed?: boolean
      paused?: boolean
      providerId?: string
      itemId?: string
    }
    if (m?.type === 'files-rebuild') void rebuildFilesHook?.()
    else if (m?.type === 'clip-text' && typeof m.text === 'string')
      clip?.addText(m.text, { concealed: !!m.concealed })
    else if (m?.type === 'clip-image' && m.hash)
      clip?.addImage(m.hash, m.bytes ?? 0, { concealed: !!m.concealed })
    else if (m?.type === 'clip-pause' && clip) clip.paused = !!m.paused
    else if (m?.type === 'activate-direct' && m.providerId && m.itemId) {
      void engine
        .get(m.providerId)
        ?.activate?.(m.itemId, undefined, engine.ctx())
        .catch(() => {})
    }
    if (m?.type === 'effect-result' && m.rid) {
      waiting.get(m.rid)?.(m.value ?? '')
      waiting.delete(m.rid)
      return
    }
    if (m?.type === 'port' && e.ports[0]) {
      detach?.()
      const port = e.ports[0]
      const like = {
        postMessage: (msg: unknown) => port.postMessage(msg),
        onmessage: null as ((ev: { data: unknown }) => void) | null,
      }
      port.on('message', (ev) => like.onmessage?.({ data: ev.data }))
      port.start()
      detach = attachSearchService(like, engine, { pin: (i) => pins.toggle(i) })
    }
  })
  dbg('ready')
  setTimeout(() => dbg('after 20s'), 20000).unref()
  parentPort.postMessage({ type: 'ready' })
}

parentPort.once('message', (e) => {
  const m = e.data as { type: string; dataDir: string; cacheDir: string; clipboardPaused?: boolean }
  if (m.type === 'init') void main(m.dataDir, m.cacheDir, !!m.clipboardPaused)
})
