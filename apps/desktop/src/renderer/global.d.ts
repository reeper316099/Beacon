export interface BeaconSettings {
  hotkey: string
  hideOnBlur: boolean
  theme: 'system' | 'dark' | 'light'
  accent: string
  glass: boolean
  launchAtLogin: boolean
  display: 'cursor' | 'primary'
}
export interface BeaconApi {
  hide(): void
  rebuildFiles(): void
  listWorkflows(): Promise<
    { file: string; raw: string; ok: boolean; error?: string; name?: string; keyword?: string }[]
  >
  saveWorkflow(file: string, raw: string): Promise<{ ok: boolean; error?: string }>
  deleteWorkflow(file: string): Promise<boolean>
  listExtensions(): Promise<
    {
      id: string
      name: string
      version: string
      description?: string
      permissions: string[]
      state: string
      error?: string
    }[]
  >
  extensionAction(op: string, id: string): Promise<boolean>
  openScriptsFolder(): Promise<string>
  openSettings(): void
  getSettings(): Promise<BeaconSettings>
  setSettings(
    patch: Partial<BeaconSettings>,
  ): Promise<{ settings: BeaconSettings; hotkey: { ok: boolean; message: string } }>
  getStatus(): Promise<Record<string, any>>
  getIcon(path: string): Promise<string | null>
  reportShown(t: number): void
  reportKeystroke(commitMs: number, paintMs: number): void
  onShown(cb: (info: { at: number }) => void): () => void
  onSetQuery(cb: (q: string) => void): () => void
  onSettings(cb: (s: BeaconSettings) => void): () => void
}
declare global {
  interface Window {
    beacon: BeaconApi
  }
}
