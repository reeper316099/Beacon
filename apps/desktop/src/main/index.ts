import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { parseWorkflow } from '@beacon/providers/workflows'
import { isAbsolute, join } from 'node:path'
import {
  BrowserWindow,
  Notification,
  ClipboardItem,
  clipboard,
  dialog,
  shell,
  Menu,
  MessageChannelMain,
  Tray,
  app,
  globalShortcut,
  ipcMain,
  screen,
  utilityProcess,
  type UtilityProcess,
} from 'electron'
import { APP_NAME } from '@beacon/shared'
import { atomicWrite } from '@beacon/jsonstore'
import { defaultDataDir, lorekeeper, cipherkeep, worldloom, classpad } from '@beacon/providers/hub'
import { ExtensionManager } from './extensions'
import { startApi } from './api'
import { trayIcon } from './icon'
import { deleteImages, watchClipboard } from './clipboardWatcher'
import { ItemHotkeys } from './itemHotkeys'
import { settingsFile, SettingsSchema, type Settings } from './settings'

const bootAt = performance.now()
app.setName(APP_NAME)

const isWayland =
  process.platform === 'linux' &&
  (process.env['XDG_SESSION_TYPE'] === 'wayland' || !!process.env['WAYLAND_DISPLAY'])
// Chromium's XDG GlobalShortcuts portal path; opt-in, compositor support varies.
if (isWayland) app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')

const WIDTH = 720
const HEIGHT = 560
/** OS cache dir (safe to delete): index caches live here, not in the data dir. */
function cacheRoot(): string {
  if (process.env['BEACON_CACHE_DIR']) return process.env['BEACON_CACHE_DIR']
  const home = app.getPath('home')
  const base =
    process.platform === 'darwin'
      ? join(home, 'Library/Caches')
      : process.platform === 'win32'
        ? (process.env['LOCALAPPDATA'] ?? join(home, 'AppData/Local'))
        : (process.env['XDG_CACHE_HOME'] ?? join(home, '.cache'))
  return join(base, APP_NAME)
}
const dataDir = process.env['BEACON_DATA_DIR'] || app.getPath('userData')

let win: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let tray: Tray | null = null
let itemHotkeys: ItemHotkeys | null = null
let extManager: ExtensionManager | null = null
let providerList: { id: string; name: string; mode: string; triggers: string[] }[] = []
let onboardingWin: BrowserWindow | null = null
const E2E = !!process.env['BEACON_E2E']
const e2eLog = (e: Record<string, unknown>) =>
  void appendFile(join(dataDir, 'runtime/e2e-actions.jsonl'), JSON.stringify(e) + '\n').catch(
    () => {},
  )
const headlessWaiters = new Map<number, (r: unknown) => void>()
let headlessSeq = 0
let worker: UtilityProcess | null = null
let settings: Settings = SettingsSchema.parse({})
const store = settingsFile(dataDir)

const perf = {
  coldStartMs: 0,
  workerIndexed: null as null | { apps: number; ms: number },
  files: null as null | { size: number; scanning: boolean; scanned: number },
  shown: [] as number[],
  keystroke: [] as number[],
  keystrokePaint: [] as number[],
}
const hotkey = { ok: false, message: '', accelerator: '' }
let lastHotkeyAt = 0

const DEEP_LINK_SCHEMES = new Set(['lorekeeper', 'cipherkeep', 'worldloom', 'classpad'])

/** Effects requested by the search worker. Only a fixed set of capabilities; URLs are scheme-checked. */
function handleEffect(kind: string, payload: unknown, rid: number): void {
  // End-to-end tests record "open" style effects instead of performing them.
  if (E2E && ['openUrl', 'openPath', 'openDeepLink', 'reveal'].includes(kind))
    return e2eLog({ kind, payload })
  switch (kind) {
    case 'copy':
      if (typeof payload === 'string' && payload.length < 1_000_000)
        void clipboard.writeText(payload).catch(() => {})
      break
    case 'openUrl':
      try {
        const u = new URL(String(payload))
        if (u.protocol === 'https:' || u.protocol === 'http:') void shell.openExternal(u.toString())
      } catch {
        /* ignore malformed URLs */
      }
      break
    case 'notify': {
      const p = payload as { title?: string; body?: string }
      if (Notification.isSupported())
        new Notification({ title: String(p.title ?? ''), body: String(p.body ?? '') }).show()
      break
    }
    case 'openDeepLink':
      // Only the user's own app schemes; never arbitrary URLs.
      try {
        const u = new URL(String(payload))
        if (DEEP_LINK_SCHEMES.has(u.protocol.replace(':', '')))
          void shell.openExternal(u.toString())
      } catch {
        /* ignore malformed */
      }
      break
    case 'openPath':
      if (typeof payload === 'string' && isAbsolute(payload)) void shell.openPath(payload)
      break
    case 'reveal':
      if (typeof payload === 'string' && isAbsolute(payload)) shell.showItemInFolder(payload)
      break
    case 'copyImage': {
      const h = String(payload)
      if (/^[0-9a-f]{16}$/.test(h))
        void readFile(join(dataDir, 'data/clipboard/images', `${h}.png`))
          .then((b) =>
            clipboard.write([
              new ClipboardItem({
                'image/png': new Blob([new Uint8Array(b)], { type: 'image/png' }),
              }),
            ]),
          )
          .catch(() => {})
      break
    }
    case 'deleteImages':
      if (Array.isArray(payload))
        void deleteImages(join(dataDir, 'data/clipboard/images'), payload.map(String))
      break
    case 'bindHotkey': {
      const p = payload as {
        accelerator: string
        providerId: string
        itemId: string
        title: string
      }
      void itemHotkeys?.bind(p.accelerator, p.providerId, p.itemId, p.title).then((err) => {
        if (Notification.isSupported())
          new Notification({
            title: err ? 'Hotkey not set' : 'Hotkey set',
            body: err ?? `${p.accelerator} → ${p.title}`,
          }).show()
      })
      break
    }
    case 'ext': {
      const reply = (r: unknown) =>
        worker?.postMessage({ type: 'effect-result', rid, value: JSON.stringify(r) })
      void (
        extManager
          ? extManager.handle(payload as never)
          : Promise.reject(new Error('extensions unavailable'))
      ).then(
        (value) => reply({ value: value ?? null }),
        (e: unknown) => reply({ error: e instanceof Error ? e.message : 'extension error' }),
      )
      break
    }
    case 'readClipboard':
      void clipboard
        .readText()
        .catch(() => '')
        .then((value) => worker?.postMessage({ type: 'effect-result', rid, value }))
      break
  }
}

function pageUrl(hash = ''): { url?: string; file?: string; hash: string } {
  const dev = process.env['ELECTRON_RENDERER_URL']
  return dev
    ? { url: dev + (hash ? '#' + hash : ''), hash }
    : { file: join(__dirname, '../renderer/index.html'), hash }
}

function load(w: BrowserWindow, hash = ''): void {
  const p = pageUrl(hash)
  if (p.url) void w.loadURL(p.url)
  else void w.loadFile(p.file as string, { hash })
}

function createWindow(): BrowserWindow {
  const glass = settings.glass
  const w = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    transparent: glass,
    hasShadow: !isWayland,
    backgroundColor: glass ? '#00000000' : '#1a1c23',
    ...(process.platform === 'darwin' && glass
      ? { vibrancy: 'under-window' as const, visualEffectState: 'active' as const }
      : {}),
    ...(process.platform === 'win32' && glass ? { backgroundMaterial: 'acrylic' as const } : {}),
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep the hidden renderer warm
    },
  })
  w.setAlwaysOnTop(true, 'pop-up-menu')
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  w.on('blur', () => {
    if (settings.hideOnBlur && !w.webContents.isDevToolsOpened()) hideLauncher()
  })
  w.webContents.on('did-finish-load', connectPort)
  load(w)
  return w
}

/** Give the renderer a direct MessagePort to the search worker (hot path bypasses main). */
function connectPort(): void {
  if (!win || !worker) return
  const { port1, port2 } = new MessageChannelMain()
  worker.postMessage({ type: 'port' }, [port1])
  win.webContents.postMessage('beacon-port', null, [port2])
}

function placeWindow(): void {
  if (!win) return
  const d =
    settings.display === 'primary'
      ? screen.getPrimaryDisplay()
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width, height } = d.workArea
  win.setPosition(Math.round(x + (width - WIDTH) / 2), Math.round(y + height * 0.2))
}

function showLauncher(): void {
  if (!win) return
  lastHotkeyAt = Date.now()
  placeWindow()
  win.show()
  win.focus()
  win.webContents.send('shown', { at: lastHotkeyAt })
  onboardingWin?.webContents.send('launcher-shown')
}

function hideLauncher(): void {
  if (!win?.isVisible()) return
  win.hide()
  // Hand focus back to the previously active app on macOS.
  if (process.platform === 'darwin') app.hide()
}

/** beacon://toggle | show | hide | query?q=text  (opened by other apps, scripts or the OS). */
function handleBeaconUrl(raw: string): void {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return
  }
  if (u.protocol !== 'beacon:') return
  const action = u.hostname || u.pathname.replace(/^\/+/, '')
  if (action === 'toggle') toggleLauncher()
  else if (action === 'hide') hideLauncher()
  else if (action === 'show' || action === 'query') {
    showLauncher()
    const q = u.searchParams.get('q')
    if (action === 'query' && q !== null) win?.webContents.send('set-query', q.slice(0, 500))
  }
}

function toggleLauncher(): void {
  if (win?.isVisible() && win.isFocused()) hideLauncher()
  else showLauncher()
}

function registerHotkey(): void {
  globalShortcut.unregisterAll()
  const accel = settings.hotkey
  let ok = false
  try {
    ok = globalShortcut.register(accel, toggleLauncher)
  } catch {
    ok = false
  }
  hotkey.accelerator = accel
  hotkey.ok = ok
  hotkey.message = ok
    ? ''
    : isWayland
      ? `Global shortcuts aren't available here (Wayland). Bind your desktop's shortcut settings to the command "beacon toggle". See docs/PLATFORMS.md.`
      : `"${accel}" couldn't be registered. Another app probably owns it; pick a different shortcut in Settings, or bind "beacon toggle" in your system shortcuts.`
}

function openOnboarding(): void {
  if (onboardingWin && !onboardingWin.isDestroyed()) return void onboardingWin.focus()
  onboardingWin = new BrowserWindow({
    width: 680,
    height: 640,
    title: `Welcome to ${APP_NAME}`,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  onboardingWin.setMenuBarVisibility(false)
  onboardingWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  onboardingWin.on('closed', () => (onboardingWin = null))
  load(onboardingWin, 'onboarding')
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Merge a patch into a hand-editable config file (other keys are preserved). */
async function patchJson(
  file: string,
  patch: (cur: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const cur = await readJson<Record<string, unknown>>(file, {})
  await atomicWrite(file, JSON.stringify(patch(cur), null, 2))
}

function openSettings(): void {
  if (settingsWin && !settingsWin.isDestroyed()) return void settingsWin.focus()
  settingsWin = new BrowserWindow({
    width: 760,
    height: 560,
    title: `${APP_NAME} Settings`,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  settingsWin.setMenuBarVisibility(false)
  settingsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  load(settingsWin, 'settings')
}

const p50 = (a: number[]) =>
  a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null

const pct = (a: number[], q: number) =>
  a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))] : null

/** Tray shows how many scripts are running (they keep running when the launcher hides). */
function setRunning(n: number): void {
  tray?.setToolTip(n ? `${APP_NAME}: ${n} script${n > 1 ? 's' : ''} running` : APP_NAME)
  if (process.platform === 'darwin') tray?.setTitle(n ? ` ${n}` : '')
}

/** One-shot query over a private MessagePort (used by the CLI). */
function headlessQuery(text: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    if (!worker) return resolve([])
    const { port1, port2 } = new MessageChannelMain()
    worker.postMessage({ type: 'aux-port' }, [port1])
    const out: Record<string, unknown>[] = []
    const finish = () => {
      port2.close()
      resolve(out.sort((a, b) => Number(b['score']) - Number(a['score'])).slice(0, 30))
    }
    const timer = setTimeout(finish, 2500)
    port2.on('message', (e) => {
      const m = e.data as {
        type: string
        items?: Record<string, unknown>[]
        error?: string
        providerId?: string
      }
      if (m.type === 'batch' && m.error)
        out.push({
          title: `provider error: ${m.error}`,
          subtitle: null,
          kind: 'error',
          provider: m.providerId,
          score: 9999,
        })
      if (m.type === 'batch')
        for (const i of m.items ?? [])
          out.push({
            title: i['title'],
            subtitle: i['subtitle'] ?? null,
            kind: i['kind'],
            provider: i['providerId'],
            score: i['score'],
          })
      if (m.type === 'done') {
        clearTimeout(timer)
        finish()
      }
    })
    port2.start()
    port2.postMessage({ type: 'query', id: 1, text })
  })
}

function headlessRun(script: string, args: string[]): Promise<unknown> {
  return new Promise((resolve) => {
    const rid = ++headlessSeq
    headlessWaiters.set(rid, resolve)
    worker?.postMessage({ type: 'headless-run', rid, script, args })
  })
}

function status() {
  return {
    app: APP_NAME,
    version: app.getVersion(),
    platform: process.platform,
    wayland: isWayland,
    hotkey,
    dataDir,
    perf: {
      coldStartMs: perf.coldStartMs,
      worker: perf.workerIndexed,
      files: perf.files,
      hotkeyToVisibleMs: {
        n: perf.shown.length,
        p50: p50(perf.shown),
        last: perf.shown.at(-1) ?? null,
      },
      keystrokeToCommitMs: {
        n: perf.keystroke.length,
        p50: p50(perf.keystroke),
        p95: pct(perf.keystroke, 0.95),
      },
      keystrokeToPaintMs: {
        n: perf.keystrokePaint.length,
        p50: p50(perf.keystrokePaint),
        p95: pct(perf.keystrokePaint, 0.95),
      },
      processes: app.getAppMetrics().map((m) => ({
        type: m.type,
        name: m.name ?? '',
        mb: Math.round(m.memory.workingSetSize / 1024),
        privateMB: Math.round((m.memory.privateBytes ?? 0) / 1024),
      })),
      rssMB: Math.round(
        app.getAppMetrics().reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024,
      ),
    },
  }
}

function broadcastSettings(): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings', settings)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => a.startsWith('beacon://'))
    if (url) handleBeaconUrl(url)
    else showLauncher()
  })
  app.on('open-url', (e, url) => {
    e.preventDefault()
    handleBeaconUrl(url)
  })
  app.on('window-all-closed', () => {}) // tray-resident
  app.on('will-quit', () => globalShortcut.unregisterAll())

  void app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock?.hide()
    // Works in packaged builds; in dev the OS can't map the scheme to the dev binary.
    app.setAsDefaultProtocolClient('beacon')
    settings = await store.load()
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin })

    worker = utilityProcess.fork(join(__dirname, 'searchWorker.js'), [], {
      serviceName: 'beacon-search',
    })
    worker.on(
      'message',
      (m: {
        type?: string
        apps?: number
        ms?: number
        kind?: string
        payload?: unknown
        rid?: number
        size?: number
        scanning?: boolean
        scanned?: number
        n?: number
        result?: unknown
      }) => {
        if (m?.type === 'ready') {
          providerList = (m as { providers?: typeof providerList }).providers ?? []
          extManager?.publish()
        }
        if (m?.type === 'scripts-running') setRunning(m.n ?? 0)
        if (m?.type === 'headless-result') {
          headlessWaiters.get(m.rid ?? -1)?.(m.result)
          headlessWaiters.delete(m.rid ?? -1)
        }
        if (m?.type === 'effect') return void handleEffect(m.kind ?? '', m.payload, m.rid ?? 0)
        if (m?.type === 'files')
          perf.files = { size: m.size ?? 0, scanning: !!m.scanning, scanned: m.scanned ?? 0 }
        if (m?.type === 'indexed') perf.workerIndexed = { apps: m.apps ?? 0, ms: m.ms ?? 0 }
      },
    )
    worker.postMessage({
      type: 'init',
      dataDir,
      cacheDir: cacheRoot(),
      clipboardPaused: settings.clipboardPaused,
    })

    win = createWindow()
    registerHotkey()
    itemHotkeys = new ItemHotkeys(
      dataDir,
      (providerId, itemId) => worker?.postMessage({ type: 'activate-direct', providerId, itemId }),
      () => settings.hotkey,
    )
    await itemHotkeys.load()
    watchClipboard(
      join(dataDir, 'data/clipboard/images'),
      (m) => worker?.postMessage(m),
      () => settings.clipboardPaused,
    )

    tray = new Tray(trayIcon())
    tray.setToolTip(APP_NAME)
    const buildTray = () =>
      Menu.buildFromTemplate([
        { label: `Show ${APP_NAME}`, click: showLauncher },
        {
          label: 'Pause clipboard history',
          type: 'checkbox',
          checked: settings.clipboardPaused,
          click: (item) => {
            settings = { ...settings, clipboardPaused: item.checked }
            void store.set(settings)
            worker?.postMessage({ type: 'clip-pause', paused: item.checked })
            broadcastSettings()
          },
        },
        { label: 'Settings…', click: openSettings },
        { label: 'Run setup again…', click: openOnboarding },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ])
    tray.setContextMenu(buildTray())

    extManager = new ExtensionManager(dataDir, (list) =>
      worker?.postMessage({ type: 'ext-list', list }),
    )
    await extManager.init()

    await startApi(dataDir, {
      toggle: toggleLauncher,
      show: showLauncher,
      hide: hideLauncher,
      status,
      query: headlessQuery,
      run: headlessRun,
      reload: () => worker?.postMessage({ type: 'reload-all' }),
    })

    // ---- settings: workflows (form + raw editor) and extensions ----
    const wfDir = join(dataDir, 'workflows')
    ipcMain.handle('workflows:list', async () => {
      await mkdir(wfDir, { recursive: true })
      const out: {
        file: string
        raw: string
        ok: boolean
        error?: string
        name?: string
        keyword?: string
      }[] = []
      for (const f of (await readdir(wfDir)).filter((n) => /\.(json|ya?ml)$/i.test(n)).sort()) {
        const raw = await readFile(join(wfDir, f), 'utf8').catch(() => '')
        const r = parseWorkflow(raw, f.toLowerCase().endsWith('.json') ? '.json' : '.yaml')
        out.push(
          r.ok
            ? { file: f, raw, ok: true, name: r.workflow.name, keyword: r.workflow.keyword }
            : { file: f, raw, ok: false, error: r.error },
        )
      }
      return out
    })
    ipcMain.handle('workflows:save', async (_e, file: unknown, raw: unknown) => {
      if (
        typeof file !== 'string' ||
        typeof raw !== 'string' ||
        !/^[A-Za-z0-9][\w.-]{0,60}\.(json|ya?ml)$/.test(file) ||
        raw.length > 100_000
      )
        return { ok: false, error: 'invalid file name or content' }
      const r = parseWorkflow(raw, file.toLowerCase().endsWith('.json') ? '.json' : '.yaml')
      if (!r.ok) return { ok: false, error: r.error }
      await mkdir(wfDir, { recursive: true })
      await writeFile(join(wfDir, file), raw)
      worker?.postMessage({ type: 'reload-all' })
      return { ok: true }
    })
    ipcMain.handle('workflows:delete', async (_e, file: unknown) => {
      if (typeof file !== 'string' || !/^[A-Za-z0-9][\w.-]{0,60}\.(json|ya?ml)$/.test(file))
        return false
      await shell.trashItem(join(wfDir, file)).catch(() => rm(join(wfDir, file), { force: true }))
      worker?.postMessage({ type: 'reload-all' })
      return true
    })
    ipcMain.handle('extensions:list', () => extManager?.list() ?? [])
    ipcMain.handle('extensions:do', async (_e, op: unknown, id: unknown) => {
      if (
        typeof id !== 'string' ||
        !['enable', 'disable', 'remove', 'reload', 'open-folder'].includes(String(op))
      )
        return false
      await extManager?.handle({ op: 'admin', admin: String(op), id })
      return true
    })
    // ---- settings/onboarding: providers, files, integrations, first run ----
    const HIDDEN_PROVIDERS = new Set([
      'recents',
      'pins',
      'aliases',
      'myapps',
      'alias',
      'hotkey',
      'hub',
      'extensions',
    ])
    const providersFile = join(dataDir, 'config/providers.json')
    ipcMain.handle('providers:list', async () => {
      const off = new Set(
        (await readJson<{ disabled?: string[] }>(providersFile, {})).disabled ?? [],
      )
      return providerList
        .filter((p) => !HIDDEN_PROVIDERS.has(p.id) && !p.id.startsWith('ext:'))
        .map((p) => ({ ...p, enabled: !off.has(p.id) }))
    })
    ipcMain.handle('providers:set', async (_e, id: unknown, enabled: unknown) => {
      if (typeof id !== 'string' || typeof enabled !== 'boolean') return false
      await patchJson(providersFile, (cur) => {
        const off = new Set((cur['disabled'] as string[] | undefined) ?? [])
        if (enabled) off.delete(id)
        else off.add(id)
        return { ...cur, disabled: [...off] }
      })
      worker?.postMessage({ type: 'providers-reload' })
      return true
    })
    const filesFile = join(dataDir, 'config/files.json')
    ipcMain.handle(
      'files:roots',
      async () =>
        (await readJson<{ roots?: string[] }>(filesFile, {})).roots ?? [app.getPath('home')],
    )
    ipcMain.handle('files:set-roots', async (_e, roots: unknown) => {
      if (
        !Array.isArray(roots) ||
        roots.length > 20 ||
        roots.some((r) => typeof r !== 'string' || !isAbsolute(r))
      )
        return false
      await patchJson(filesFile, (cur) => ({ ...cur, roots }))
      worker?.postMessage({ type: 'files-rebuild' })
      return true
    })
    ipcMain.handle('dialog:pick-folder', async (e) => {
      const parent = BrowserWindow.fromWebContents(e.sender)
      const r = await (parent
        ? dialog.showOpenDialog(parent, { properties: ['openDirectory'] })
        : dialog.showOpenDialog({ properties: ['openDirectory'] }))
      return r.canceled ? null : (r.filePaths[0] ?? null)
    })
    const intFile = join(dataDir, 'config/integrations.json')
    ipcMain.handle('integrations:detect', async () => {
      const cfg = await readJson<Record<string, { enabled?: boolean }>>(intFile, {})
      const out: { id: string; name: string; found: boolean; enabled: boolean }[] = []
      for (const a of [lorekeeper, cipherkeep, worldloom, classpad]) {
        const dir = defaultDataDir(a.dataDirEnv, a.folderName)
        const found = await readdir(dir).then(
          () => true,
          () => false,
        )
        out.push({ id: a.id, name: a.name, found, enabled: !!cfg[a.id]?.enabled })
      }
      return out
    })
    ipcMain.handle('integrations:set', async (_e, id: unknown, enabled: unknown) => {
      if (
        typeof id !== 'string' ||
        typeof enabled !== 'boolean' ||
        !['lorekeeper', 'cipherkeep', 'worldloom', 'classpad'].includes(id)
      )
        return false
      await patchJson(intFile, (cur) => ({
        ...cur,
        [id]: { deepLinks: false, showSpoilers: false, ...((cur[id] as object) ?? {}), enabled },
      }))
      worker?.postMessage({ type: 'integrations-reload' })
      return true
    })
    ipcMain.handle('onboarding:done', async () => {
      const next = SettingsSchema.parse({ ...settings, onboarded: true })
      await store.set(next)
      settings = next
      broadcastSettings()
      onboardingWin?.close()
      return true
    })
    ipcMain.on('onboarding:open', openOnboarding)
    ipcMain.handle('scripts:open-folder', () => shell.openPath(join(dataDir, 'scripts')))

    ipcMain.on('hide', hideLauncher)
    ipcMain.on('files:rebuild', () => worker?.postMessage({ type: 'files-rebuild' }))
    ipcMain.on('open-settings', () => {
      hideLauncher()
      openSettings()
    })
    ipcMain.handle('settings:get', () => settings)
    ipcMain.handle('status:get', status)
    ipcMain.handle('settings:set', async (_e, patch: unknown) => {
      const next = SettingsSchema.parse({ ...settings, ...(patch as object) })
      const hotkeyChanged = next.hotkey !== settings.hotkey
      await store.set(next)
      settings = next
      if (hotkeyChanged) registerHotkey()
      app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin })
      broadcastSettings()
      return { settings, hotkey }
    })
    const iconCache = new Map<string, string>()
    ipcMain.handle('icon:get', async (_e, path: unknown) => {
      if (typeof path !== 'string' || path.length > 4096) return null
      const hit = iconCache.get(path)
      if (hit) return hit
      try {
        const url = (await app.getFileIcon(path, { size: 'normal' })).toDataURL()
        iconCache.set(path, url)
        return url
      } catch {
        return null
      }
    })
    ipcMain.on('perf:shown', (_e, t: number) => {
      if (lastHotkeyAt && t >= lastHotkeyAt) perf.shown.push(t - lastHotkeyAt)
      if (perf.shown.length > 200) perf.shown.shift()
    })
    ipcMain.on('perf:keystroke', (_e, commit: number, paint: number) => {
      onboardingWin?.webContents.send('launcher-typed')
      perf.keystroke.push(commit)
      perf.keystrokePaint.push(paint)
      if (perf.keystroke.length > 500) {
        perf.keystroke.shift()
        perf.keystrokePaint.shift()
      }
    })

    if (!settings.onboarded && !process.env['BEACON_SMOKE']) openOnboarding()
    perf.coldStartMs = Math.round(performance.now() - bootAt)
    if (process.env['BEACON_SMOKE']) runSmoke()
  })
}

/** Dev/CI smoke: show/hide a few times, print §2 numbers as JSON, exit. */
function runSmoke(): void {
  setTimeout(async () => {
    for (let i = 0; i < 10; i++) {
      showLauncher()
      await new Promise((r) => setTimeout(r, 400))
      hideLauncher()
      await new Promise((r) => setTimeout(r, 200))
    }
    // Type into the launcher to exercise keystroke → paint, and capture a screenshot.
    showLauncher()
    await new Promise((r) => setTimeout(r, 400))
    for (const q of [
      '',
      'a',
      'ap',
      'app',
      's',
      'sa',
      'saf',
      'safa',
      'c',
      'ch',
      'chr',
      'chro',
      'f',
      'fi',
      'fir',
      'fire',
      't',
      'te',
      'ter',
      'term',
      'x',
      'xc',
      'xco',
      ...(process.env['BEACON_QUERY'] ? [process.env['BEACON_QUERY']] : []),
    ]) {
      win?.webContents.executeJavaScript(
        `(() => { const i = document.querySelector('input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(q)}); i.dispatchEvent(new Event('input', { bubbles: true })) })()`,
      )
      await new Promise((r) => setTimeout(r, 120))
    }
    // Optional scripted keys (dev/CI): BEACON_KEYS="Enter,Enter" → screenshots BEACON_SHOT-<n>.png after each.
    const shot = process.env['BEACON_SHOT']
    const keys = (process.env['BEACON_KEYS'] ?? '').split(',').filter(Boolean)
    for (const [i, k] of keys.entries()) {
      const [key, ...mods] = k.split('+').reverse()
      await win?.webContents.executeJavaScript(
        `document.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ctrlKey: ${mods.includes('Ctrl')}, metaKey: false, bubbles: true }))`,
      )
      await new Promise((r) => setTimeout(r, 1200))
      if (shot && win)
        (await import('node:fs')).writeFileSync(
          shot.replace('.png', `-${i + 1}.png`),
          (await win.webContents.capturePage()).toPNG(),
        )
    }

    if (shot && win)
      (await import('node:fs')).writeFileSync(shot, (await win.webContents.capturePage()).toPNG())
    console.log(
      'BEACON_SAMPLES ' +
        JSON.stringify({
          commit: perf.keystroke.map((x) => +x.toFixed(1)),
          paint: perf.keystrokePaint.map((x) => +x.toFixed(1)),
        }),
    )
    console.log('BEACON_SMOKE ' + JSON.stringify(status()))
    app.exit(0)
  }, 2500)
}
