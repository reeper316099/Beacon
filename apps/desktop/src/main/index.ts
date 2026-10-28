import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BrowserWindow,
  Notification,
  ClipboardItem,
  clipboard,
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
const dataDir = process.env['BEACON_DATA_DIR'] || app.getPath('userData')

let win: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let tray: Tray | null = null
let itemHotkeys: ItemHotkeys | null = null
let worker: UtilityProcess | null = null
let settings: Settings = SettingsSchema.parse({})
const store = settingsFile(dataDir)

const perf = {
  coldStartMs: 0,
  workerIndexed: null as null | { apps: number; ms: number },
  shown: [] as number[],
  keystroke: [] as number[],
  keystrokePaint: [] as number[],
}
const hotkey = { ok: false, message: '', accelerator: '' }
let lastHotkeyAt = 0

/** Effects requested by the search worker. Only a fixed set of capabilities; URLs are scheme-checked. */
function handleEffect(kind: string, payload: unknown, rid: number): void {
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
}

function hideLauncher(): void {
  if (!win?.isVisible()) return
  win.hide()
  // Hand focus back to the previously active app on macOS.
  if (process.platform === 'darwin') app.hide()
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
  app.on('second-instance', showLauncher)
  app.on('window-all-closed', () => {}) // tray-resident
  app.on('will-quit', () => globalShortcut.unregisterAll())

  void app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock?.hide()
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
      }) => {
        if (m?.type === 'effect') return void handleEffect(m.kind ?? '', m.payload, m.rid ?? 0)
        if (m?.type === 'indexed') perf.workerIndexed = { apps: m.apps ?? 0, ms: m.ms ?? 0 }
      },
    )
    worker.postMessage({ type: 'init', dataDir, clipboardPaused: settings.clipboardPaused })

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
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ])
    tray.setContextMenu(buildTray())

    await startApi(dataDir, {
      toggle: toggleLauncher,
      show: showLauncher,
      hide: hideLauncher,
      status,
    })

    ipcMain.on('hide', hideLauncher)
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
      perf.keystroke.push(commit)
      perf.keystrokePaint.push(paint)
      if (perf.keystroke.length > 500) {
        perf.keystroke.shift()
        perf.keystrokePaint.shift()
      }
    })

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
    const shot = process.env['BEACON_SHOT']
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
