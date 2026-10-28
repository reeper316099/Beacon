// Search worker (Electron utilityProcess). Owns indexes, frecency and providers; talks to the
// renderer directly over a MessagePort so the hot path never touches the main process.
import { execFile, fork, type ChildProcess } from 'node:child_process'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  AliasProvider,
  DEFAULT_SCRIPTS_CONFIG,
  ExtensionAdminProvider,
  ExtensionProxyProvider,
  ScriptManager,
  ScriptTrust,
  ScriptsProvider,
  WorkflowProvider,
  WorkflowStore,
  parseSshConfig,
  scanScripts,
  watchScripts,
  type ExtBridge,
  type ExtInfo,
  type ScriptEntry,
  type ScriptsConfig,
  type TrustFile,
  HubSetupProvider,
  HubSourceProvider,
  cipherkeep,
  classpad,
  lorekeeper,
  worldloom,
  type IntegrationsFile,
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
import chokidar from 'chokidar'
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
let applyProviderConfig: (() => Promise<void>) | undefined
let reloadIntegrations: (() => Promise<void>) | undefined
let reloadAll: (() => Promise<void>) | undefined
let headlessRun: ((ref: string, args: string[]) => Promise<unknown>) | undefined
let syncExtensions: ((list: ExtInfo[]) => void) | undefined
let hooksRef: Parameters<typeof attachSearchService>[2] | undefined
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
  openDeepLink: async (url) => void (await effect('openDeepLink', url)),
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
const integrationsSchema = z.record(
  z.object({
    enabled: z.boolean().default(false),
    dir: z.string().optional(),
    deepLinks: z.boolean().default(false),
    showSpoilers: z.boolean().default(false),
  }),
)
const scriptsSchema = z.object({
  folders: z
    .array(
      z.object({
        path: z.string(),
        interpreters: z.record(z.string()).optional(),
        cwd: z.string().optional(),
        env: z.array(z.string()).optional(),
        extraPath: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  envAllow: z.array(z.string()).default([]),
  extraPath: z.array(z.string()).default([]),
  timeoutSec: z.number().positive().default(30),
  maxOutputBytes: z.number().int().positive().default(1_048_576),
  concurrency: z.number().int().positive().default(4),
  history: z.boolean().default(false),
  tsRunner: z.array(z.string()).optional(),
  terminal: z.object({ command: z.array(z.string()).optional() }).optional(),
})
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

/** Empty-state "Launch my apps": whichever of the user's four apps are installed. */
class MyAppsProvider implements Provider {
  id = 'myapps'
  name = 'My apps'
  mode = 'global' as const
  constructor(
    private apps: AppsProvider,
    private names: Set<string>,
  ) {}
  async query(q: ParsedQuery): Promise<ResultItem[]> {
    if (q.text) return []
    const out: ResultItem[] = []
    for (const a of this.apps.byId.values()) {
      if (!this.names.has(a.name.toLowerCase())) continue
      const r: ResultItem = {
        id: a.id,
        providerId: this.apps.id,
        title: a.name,
        subtitle: 'My apps',
        kind: 'app',
        score: 50,
        primary: { id: 'launch', title: 'Open', kind: 'open', payload: null },
      }
      if (a.iconPath) r.icon = a.iconPath
      out.push(r)
    }
    return out
  }
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

  // My apps hub: every adapter is off until enabled (via `hub `), read-only, and re-read lazily.
  const intFile = file<IntegrationsFile>(
    'config/integrations.json',
    integrationsSchema as never,
    () => ({}),
  )
  await intFile.load()
  reloadIntegrations = async () => {
    await intFile.load()
    await Promise.all([...hubProviders.values()].map((p) => p.reload()))
  }
  const adapters = [lorekeeper, cipherkeep, worldloom, classpad]
  const hubProviders = new Map(adapters.map((a) => [a.id, new HubSourceProvider(a, intFile)]))
  const MY_APPS = new Set(adapters.map((a) => a.name.toLowerCase()))

  // Files: configurable source; the built-in index is crawled in the background, throttled and cancellable.
  const filesFile = file<FilesConfig>('config/files.json', filesConfigSchema as never, () =>
    filesConfigSchema.parse({}),
  )
  let filesCfg = await filesFile.load()
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
  let ignore = makeIgnore([...DEFAULT_IGNORE_NAMES, ...filesCfg.ignoreNames], filesCfg.ignoreGlobs)
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
  // Settings/onboarding change the roots in config/files.json, then ask for a rebuild.
  rebuildFilesHook = async () => {
    filesCfg = await filesFile.load()
    ignore = makeIgnore([...DEFAULT_IGNORE_NAMES, ...filesCfg.ignoreNames], filesCfg.ignoreGlobs)
    await rebuildFiles()
  }
  dbg('files set up')
  engine.register(new RecentsProvider(apps, frecency))
  // Per-provider switches (config/providers.json, edited from Settings/onboarding or by hand).
  const providersFile = file<{ disabled: string[] }>(
    'config/providers.json',
    z.object({ disabled: z.array(z.string()).default([]) }) as never,
    () => ({ disabled: [] }),
  )
  await providersFile.load()
  engine.opts.disabled = new Set(providersFile.data.disabled)
  applyProviderConfig = async () => {
    await providersFile.load()
    engine.opts.disabled = new Set(providersFile.data.disabled)
  }
  // ---- scripts, workflows, extensions (M8) ----
  const scriptsCfg = file<ScriptsConfig>(
    'config/scripts.json',
    scriptsSchema as never,
    () => scriptsSchema.parse({}) as ScriptsConfig,
  )
  await scriptsCfg.load()
  const trustFile = file<TrustFile>(
    'config/script-trust.json',
    z.record(z.any()) as never,
    () => ({}),
  )
  await trustFile.load()
  const scriptsDir = join(dataDir, 'scripts')
  await mkdir(scriptsDir, { recursive: true })
  let scriptEntries: ScriptEntry[] = []
  let stopScriptWatch: (() => Promise<void>) | undefined
  const effectiveScriptsCfg = (): ScriptsConfig => {
    const c = { ...DEFAULT_SCRIPTS_CONFIG, ...scriptsCfg.data }
    // The default scripts folder is always included so "New script" has somewhere to go.
    return c.folders.some((f) => f.path === scriptsDir)
      ? c
      : { ...c, folders: [...c.folders, { path: scriptsDir }] }
  }
  const reloadScripts = async (): Promise<void> => {
    const c = effectiveScriptsCfg()
    scriptEntries = await scanScripts(c)
    await stopScriptWatch?.()
    stopScriptWatch = watchScripts(
      c.folders.map((f) => f.path),
      () => void reloadScripts(),
    )
  }
  const scriptManager = new ScriptManager({
    cfg: effectiveScriptsCfg,
    entries: () => scriptEntries,
    trust: new ScriptTrust(trustFile, join(dataDir, 'data/script-runs/trusted')),
    effects: () => effects,
    historyFile: join(dataDir, 'data/script-runs/history.jsonl'),
    sshHosts: async () =>
      (await parseSshConfig(join(homedir(), '.ssh/config'))).map((h) => h.alias),
    onRunningChange: (n) => parentPort.postMessage({ type: 'scripts-running', n }),
  })
  void reloadScripts()
  // Hand edits to scripts.json take effect live.
  chokidar
    .watch(scriptsCfg.path, { ignoreInitial: true })
    .on('change', () => void scriptsCfg.load().then(reloadScripts))
    .on('error', () => {})

  const wfStore = new WorkflowStore(join(dataDir, 'workflows'))
  await mkdir(wfStore.dir, { recursive: true })
  const wfProvider = new WorkflowProvider(wfStore, (ref, args) =>
    scriptManager.runHeadless(ref, args),
  )
  const reloadWorkflows = async () => {
    await wfStore.load()
    wfProvider.refreshTriggers()
  }
  await reloadWorkflows()
  let wfTimer: NodeJS.Timeout | undefined
  chokidar
    .watch(wfStore.dir, { ignoreInitial: true, depth: 0 })
    .on('all', () => {
      clearTimeout(wfTimer)
      wfTimer = setTimeout(() => void reloadWorkflows(), 250)
    })
    .on('error', () => {})
  reloadAll = async () => {
    await Promise.all([scriptsCfg.load(), trustFile.load()])
    await Promise.all([reloadScripts(), reloadWorkflows()])
  }
  headlessRun = (ref, args) => scriptManager.runHeadless(ref, args)

  const extTrust = file<string[]>(
    'config/extension-trust.json',
    z.array(z.string()) as never,
    () => [],
  )
  await extTrust.load()
  let extList: ExtInfo[] = []
  const proxies = new Map<string, ExtensionProxyProvider>()
  const ask = async (payload: unknown): Promise<unknown> => {
    const r = JSON.parse(await effect('ext', payload, true)) as { error?: string; value?: unknown }
    if (r.error) throw new Error(r.error)
    return r.value
  }
  const extBridge: ExtBridge = {
    query: async (id, q) => (await ask({ op: 'query', id, q })) as never,
    activate: async (id, itemId, actionId) =>
      void (await ask({ op: 'activate', id, itemId, actionId })),
    admin: async (op, id) => void (await ask({ op: 'admin', admin: op, id })),
  }
  syncExtensions = (list) => {
    extList = list
    for (const id of proxies.keys()) engine.unregister('ext:' + id)
    proxies.clear()
    for (const info of list) {
      if (info.state !== 'enabled' && info.state !== 'restarting') continue
      const p = new ExtensionProxyProvider(info, extBridge, extTrust)
      proxies.set(info.id, p)
      engine.register(p)
    }
  }
  hooksRef = {
    pin: (i) => pins.toggle(i),
    scriptRun: (msg, post) =>
      void scriptManager.run(
        msg.runId,
        {
          scriptId: msg.scriptId,
          ...(msg.args ? { args: msg.args } : {}),
          ...(msg.trustHash ? { trustHash: msg.trustHash } : {}),
          ...(msg.confirmed ? { confirmed: true } : {}),
          ...(msg.selection !== undefined ? { selection: msg.selection } : {}),
        },
        (e) => post(e as unknown as Record<string, unknown>),
      ),
    scriptCancel: (runId) => scriptManager.cancel(runId),
  }

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
    new ScriptsProvider(scriptManager, () => scriptEntries, scriptsCfg, scriptsDir, reloadScripts),
    wfProvider,
    new ExtensionAdminProvider(() => extList, extBridge),
    new HubSetupProvider(adapters, intFile, hubProviders),
    ...hubProviders.values(),
    new MyAppsProvider(apps, MY_APPS),
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
  const fixture = process.env['BEACON_APPS_FIXTURE']
  void (
    fixture
      ? import('node:fs/promises').then(
          async (fs) =>
            JSON.parse(await fs.readFile(fixture, 'utf8')) as Awaited<
              ReturnType<typeof discoverApps>
            >,
        )
      : discoverApps(plat, { convertPlist, getStartApps })
  ).then(async (list) => {
    apps.setAll(list)
    engine.invalidate() // a query typed before the index was ready shows its results now
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
  if (!process.env['BEACON_APPS_FIXTURE']) watchRoots(roots, (r) => void rescan(r))

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
      list?: ExtInfo[]
      script?: string
      args?: string[]
    }
    if (m?.type === 'files-rebuild') void rebuildFilesHook?.()
    else if (m?.type === 'providers-reload') void applyProviderConfig?.()
    else if (m?.type === 'integrations-reload') void reloadIntegrations?.()
    else if (m?.type === 'reload-all') void reloadAll?.()
    else if (m?.type === 'ext-list' && m.list) syncExtensions?.(m.list)
    else if (m?.type === 'headless-run' && m.rid)
      void headlessRun?.(m.script ?? '', m.args ?? []).then((result) =>
        parentPort.postMessage({ type: 'headless-result', rid: m.rid, result }),
      )
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
      detach = attachSearchService(like, engine, hooksRef ?? { pin: (i) => pins.toggle(i) })
    }
    if (m?.type === 'aux-port' && e.ports[0]) {
      // Extra short-lived port (CLI queries). Does not replace the launcher's port.
      const port = e.ports[0]
      const like = {
        postMessage: (msg: unknown) => port.postMessage(msg),
        onmessage: null as ((ev: { data: unknown }) => void) | null,
      }
      port.on('message', (ev) => like.onmessage?.({ data: ev.data }))
      port.start()
      attachSearchService(like, engine, {})
    }
  })
  dbg('ready')
  setTimeout(() => dbg('after 20s'), 20000).unref()
  parentPort.postMessage({ type: 'ready', providers: engine.list() })
}

parentPort.once('message', (e) => {
  const m = e.data as { type: string; dataDir: string; cacheDir: string; clipboardPaused?: boolean }
  if (m.type === 'init') void main(m.dataDir, m.cacheDir, !!m.clipboardPaused)
})
