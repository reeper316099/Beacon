import { contextBridge, ipcRenderer } from 'electron'

// Forward the search MessagePort from main into the page (ports can't cross contextBridge).
ipcRenderer.on('beacon-port', (e) => window.postMessage('beacon-port', '*', e.ports))

const on = (ch: string, cb: (...a: never[]) => void) => {
  const f = (_: unknown, ...a: unknown[]) => (cb as (...x: unknown[]) => void)(...a)
  ipcRenderer.on(ch, f)
  return () => ipcRenderer.removeListener(ch, f)
}

contextBridge.exposeInMainWorld('beacon', {
  hide: () => ipcRenderer.send('hide'),
  openSettings: () => ipcRenderer.send('open-settings'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
  getStatus: () => ipcRenderer.invoke('status:get'),
  getIcon: (path: string) => ipcRenderer.invoke('icon:get', path),
  reportShown: (t: number) => ipcRenderer.send('perf:shown', t),
  reportKeystroke: (commit: number, paint: number) =>
    ipcRenderer.send('perf:keystroke', commit, paint),
  onShown: (cb: (info: { at: number }) => void) => on('shown', cb as never),
  onSettings: (cb: (s: unknown) => void) => on('settings', cb as never),
})
