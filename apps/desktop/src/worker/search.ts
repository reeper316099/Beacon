// Search worker (Electron utilityProcess). Owns indexes, frecency and providers; talks to the
// renderer directly over a MessagePort so the hot path never touches the main process.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { z } from 'zod'
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
import type { ParsedQuery, Provider, ResultItem } from '@beacon/shared'

const parentPort = (process as unknown as { parentPort: Electron.ParentPort }).parentPort

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
  const engine = new SearchEngine({ frecency, timeoutMs: 250 })

  const apps = new AppsProvider()
  engine.register(apps)
  engine.register(new RecentsProvider(apps, frecency))

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
    const m = e.data as { type?: string }
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
