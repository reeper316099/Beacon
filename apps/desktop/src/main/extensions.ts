import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { Notification, clipboard, dialog, shell, utilityProcess } from 'electron'
import chokidar from 'chokidar'
import { z } from 'zod'
import { JsonFile } from '@beacon/jsonstore'
import {
  ExtensionHost,
  describePermission,
  parseManifest,
  type ExtInfo,
  type ExtPlatform,
  type ExtProc,
  type LoadedExtension,
  type Manifest,
} from '@beacon/providers/extensions'

const stateSchema = z.record(z.object({ enabled: z.boolean(), granted: z.array(z.string()) }))
const MAX_CODE = 1_000_000

/**
 * Owns extension processes. Each extension runs in its own utilityProcess + QuickJS sandbox, default-deny:
 * every capability it asks for is checked against the permissions the user approved in the prompt.
 */
export class ExtensionManager {
  readonly dir: string
  readonly host: ExtensionHost
  private state: JsonFile<z.infer<typeof stateSchema>>
  private scanned = new Map<
    string,
    { manifest?: Manifest; dir: string; error?: string; codeHash?: string }
  >()
  private loadedHash = new Map<string, string>()

  constructor(
    private dataDir: string,
    private onList: (list: ExtInfo[]) => void,
  ) {
    this.dir = join(dataDir, 'extensions')
    this.state = new JsonFile({
      path: join(dataDir, 'config/extensions.json'),
      schema: stateSchema as never,
      defaults: () => ({}),
    })
    this.host = new ExtensionHost((e) => this.spawn(e), this.platform())
  }

  private spawn(ext: LoadedExtension): ExtProc {
    const child = utilityProcess.fork(join(__dirname, 'extProcess.js'), [], {
      serviceName: `beacon-ext-${ext.manifest.id}`,
      stdio: 'ignore',
    })
    return {
      send: (m) => child.postMessage(m),
      onMessage: (cb) => child.on('message', cb),
      onExit: (cb) => child.on('exit', cb),
      kill: () => void child.kill(),
    }
  }

  private platform(): ExtPlatform {
    const storeFile = (id: string) => join(this.dataDir, 'data/extensions-data', `${id}.json`)
    const readStore = async (id: string): Promise<Record<string, unknown>> => {
      try {
        return JSON.parse(await fs.readFile(storeFile(id), 'utf8')) as Record<string, unknown>
      } catch {
        return {}
      }
    }
    return {
      clipboardRead: () => clipboard.readText(),
      clipboardWrite: (t) => clipboard.writeText(t),
      notify: async (name, title, body) => {
        if (Notification.isSupported())
          new Notification({ title: `${name}: ${title}`, body: body ?? '' }).show()
      },
      fsRead: async (p) => {
        const st = await fs.stat(p)
        if (!st.isFile() || st.size > 2_000_000)
          throw new Error('not a regular file or too large (2 MB limit)')
        return fs.readFile(p, 'utf8')
      },
      fsWrite: async (p, d) => {
        if (d.length > 1_000_000) throw new Error('too large (1 MB limit)')
        await fs.writeFile(p, d)
      },
      exec: (file, args) =>
        new Promise((res) =>
          // argv only; `file` has already been matched against the exec allow-list.
          execFile(
            file,
            args,
            { timeout: 10_000, maxBuffer: 1_000_000, shell: false, windowsHide: true },
            (e, stdout, stderr) =>
              res({
                code: e
                  ? typeof (e as { code?: unknown }).code === 'number'
                    ? (e as { code: number }).code
                    : 1
                  : 0,
                stdout: String(stdout),
                stderr: String(stderr),
              }),
          ),
        ),
      fetch: async (url, opts) => {
        const ctl = new AbortController()
        const t = setTimeout(() => ctl.abort(), 8000)
        try {
          // Redirects are not followed: a redirect could leave the host allow-list.
          const r = await fetch(url, {
            method: opts.method ?? 'GET',
            headers: opts.headers ?? {},
            ...(opts.body !== undefined ? { body: opts.body } : {}),
            redirect: 'manual',
            signal: ctl.signal,
          })
          return { status: r.status, body: (await r.text()).slice(0, 1_000_000) }
        } finally {
          clearTimeout(t)
        }
      },
      storageGet: async (id, k) => (await readStore(id))[k] ?? null,
      storageSet: async (id, k, v) => {
        const d = await readStore(id)
        d[k] = v
        await fs.mkdir(join(this.dataDir, 'data/extensions-data'), { recursive: true })
        await fs.writeFile(storeFile(id), JSON.stringify(d))
      },
      realpath: (p) => fs.realpath(p),
    }
  }

  async init(): Promise<void> {
    await this.state.load()
    await fs.mkdir(this.dir, { recursive: true })
    await this.rescan()
    // Hot reload: edit an extension's files and it restarts (works for installed extensions too).
    let t: NodeJS.Timeout | undefined
    chokidar
      .watch(this.dir, { ignoreInitial: true, depth: 3 })
      .on('all', () => {
        clearTimeout(t)
        t = setTimeout(() => void this.rescan(), 300)
      })
      .on('error', () => {})
  }

  private async rescan(): Promise<void> {
    this.scanned.clear()
    for (const e of await fs.readdir(this.dir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const dir = join(this.dir, e.name)
      let text: string
      try {
        text = await fs.readFile(join(dir, 'manifest.json'), 'utf8')
      } catch {
        continue
      }
      const r = parseManifest(text)
      if (!r.ok) this.scanned.set(e.name, { dir, error: r.error })
      else if (r.manifest.id !== e.name)
        this.scanned.set(e.name, { dir, error: `folder name must match the id "${r.manifest.id}"` })
      else this.scanned.set(r.manifest.id, { dir, manifest: r.manifest })
    }
    // (Re)load enabled extensions whose granted permissions still match; changed code restarts.
    for (const [id, s] of this.scanned) {
      const st = this.state.data[id]
      if (!s.manifest) continue
      const consent = st?.enabled && sameSet(st.granted, s.manifest.permissionStrings)
      if (!consent) {
        this.host.unload(id)
        this.loadedHash.delete(id)
        continue
      }
      const code = await this.readCode(s.dir, s.manifest).catch(() => undefined)
      if (code === undefined) continue
      const h = createHash('sha256').update(code).update(JSON.stringify(s.manifest)).digest('hex')
      if (this.loadedHash.get(id) !== h) {
        this.host.load({ manifest: s.manifest, code })
        this.loadedHash.set(id, h)
      }
    }
    for (const id of [...this.loadedHash.keys()]) {
      if (this.scanned.get(id)?.manifest) continue
      this.host.unload(id)
      this.loadedHash.delete(id)
    }
    this.publish()
  }

  private async readCode(dir: string, m: Manifest): Promise<string> {
    const file = await fs.realpath(resolve(dir, m.main))
    const root = await fs.realpath(dir)
    if (!file.startsWith(root + sep)) throw new Error('main points outside the extension folder')
    const st = await fs.stat(file)
    if (st.size > MAX_CODE) throw new Error('extension code too large')
    return fs.readFile(file, 'utf8')
  }

  list(): ExtInfo[] {
    return [...this.scanned.entries()].map(([id, s]): ExtInfo => {
      if (!s.manifest)
        return {
          id,
          name: id,
          version: '?',
          keywords: [],
          permissions: [],
          state: 'invalid',
          ...(s.error ? { error: s.error } : {}),
        }
      const st = this.state.data[id]
      const hs = this.host.state(id)
      const consented = !!st?.enabled && sameSet(st.granted, s.manifest.permissionStrings)
      return {
        id,
        name: s.manifest.name,
        version: s.manifest.version,
        ...(s.manifest.description ? { description: s.manifest.description } : {}),
        keywords: s.manifest.commands.map((c) => c.keyword),
        permissions: s.manifest.permissions.map(describePermission),
        state: consented
          ? hs === 'crashed'
            ? 'crashed'
            : hs === 'restarting'
              ? 'restarting'
              : 'enabled'
          : st?.enabled
            ? 'needs-consent'
            : 'disabled',
      }
    })
  }

  publish(): void {
    this.onList(this.list())
  }

  /** Native consent prompt listing every permission. The extension stays off unless the user agrees. */
  async enable(id: string): Promise<void> {
    const m = this.scanned.get(id)?.manifest
    if (!m) throw new Error('extension not found or invalid')
    const lines = m.permissions.length
      ? m.permissions.map((p) => '• ' + describePermission(p))
      : ['• (no special permissions)']
    const r = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Enable', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Enable extension',
      message: `Enable “${m.name}” ${m.version}?`,
      detail: `This extension will be able to:\n\n${lines.join('\n')}\n\nExtensions are not signed or reviewed. Only enable extensions you trust. It runs in an isolated sandbox and cannot do anything not listed above.`,
    })
    if (r.response !== 0) return
    await this.state.update((d) => ({
      ...d,
      [id]: { enabled: true, granted: m.permissionStrings },
    }))
    await this.rescan()
  }

  async disable(id: string): Promise<void> {
    await this.state.update((d) => ({
      ...d,
      [id]: { enabled: false, granted: d[id]?.granted ?? [] },
    }))
    await this.rescan()
  }

  async remove(id: string): Promise<void> {
    const s = this.scanned.get(id)
    if (!s) return
    this.host.unload(id)
    this.loadedHash.delete(id)
    await shell.trashItem(s.dir)
    await this.state.update((d) => {
      const n = { ...d }
      delete n[id]
      return n
    })
    await this.rescan()
  }

  async reload(id: string): Promise<void> {
    this.loadedHash.delete(id)
    await this.rescan()
  }

  /** Messages from the search worker (`effect` kind "ext"). */
  async handle(p: {
    op: string
    id?: string
    q?: unknown
    itemId?: string
    actionId?: string
    admin?: string
  }): Promise<unknown> {
    const id = String(p.id ?? '')
    if (p.op === 'query') return this.host.query(id, p.q as never)
    if (p.op === 'activate')
      return void (await this.host.activate(id, String(p.itemId), p.actionId))
    if (p.op === 'admin') {
      switch (p.admin) {
        case 'enable':
          return this.enable(id)
        case 'disable':
          return this.disable(id)
        case 'remove':
          return this.remove(id)
        case 'reload':
          return this.reload(id)
        case 'open-folder':
          return void (await shell.openPath(this.dir))
      }
    }
    throw new Error('unknown extension operation')
  }
}

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n')
