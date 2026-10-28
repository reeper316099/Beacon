// Search worker (Electron utilityProcess). Owns indexes, frecency and providers; talks to the
// renderer directly over a MessagePort so the hot path never touches the main process.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { z } from 'zod'
import {
  CalculatorProvider,
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

const parentPort = (process as unknown as { parentPort: Electron.ParentPort }).parentPort

// Side effects (clipboard, browser, notifications) are performed by the main process.
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
}

const quicklinkSchema = z.array(
  z.object({ keyword: z.string().min(1), name: z.string(), url: z.string() }),
)
const timersSchema = z.array(
  z.object({ id: z.string(), label: z.string(), endsAt: z.number(), startedAt: z.number() }),
)
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

async function main(dataDir: string): Promise<void> {
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
  engine.register(new RecentsProvider(apps, frecency))
  for (const p of [
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
    const m = e.data as { type?: string; rid?: number; value?: string }
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
      detach = attachSearchService(like, engine)
    }
  })
  parentPort.postMessage({ type: 'ready' })
}

parentPort.once('message', (e) => {
  const m = e.data as { type: string; dataDir: string }
  if (m.type === 'init') void main(m.dataDir)
})
