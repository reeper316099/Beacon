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
  listWorkflows: () => ipcRenderer.invoke('workflows:list'),
  saveWorkflow: (file: string, raw: string) => ipcRenderer.invoke('workflows:save', file, raw),
  deleteWorkflow: (file: string) => ipcRenderer.invoke('workflows:delete', file),
  listExtensions: () => ipcRenderer.invoke('extensions:list'),
  extensionAction: (op: string, id: string) => ipcRenderer.invoke('extensions:do', op, id),
  openScriptsFolder: () => ipcRenderer.invoke('scripts:open-folder'),
  listProviders: () => ipcRenderer.invoke('providers:list'),
  setProvider: (id: string, enabled: boolean) => ipcRenderer.invoke('providers:set', id, enabled),
  getFileRoots: () => ipcRenderer.invoke('files:roots'),
  setFileRoots: (roots: string[]) => ipcRenderer.invoke('files:set-roots', roots),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  detectIntegrations: () => ipcRenderer.invoke('integrations:detect'),
  setIntegration: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('integrations:set', id, enabled),
  finishOnboarding: () => ipcRenderer.invoke('onboarding:done'),
  openOnboarding: () => ipcRenderer.send('onboarding:open'),
  onLauncherShown: (cb: () => void) => on('launcher-shown', cb as never),
  onLauncherTyped: (cb: () => void) => on('launcher-typed', cb as never),
  rebuildFiles: () => ipcRenderer.send('files:rebuild'),
  openSettings: () => ipcRenderer.send('open-settings'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
  getStatus: () => ipcRenderer.invoke('status:get'),
  getIcon: (path: string) => ipcRenderer.invoke('icon:get', path),
  reportShown: (t: number) => ipcRenderer.send('perf:shown', t),
  reportKeystroke: (commit: number, paint: number) =>
    ipcRenderer.send('perf:keystroke', commit, paint),
  onShown: (cb: (info: { at: number }) => void) => on('shown', cb as never),
  onSetQuery: (cb: (q: string) => void) => on('set-query', cb as never),
  onSettings: (cb: (s: unknown) => void) => on('settings', cb as never),
})
