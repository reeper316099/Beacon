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
