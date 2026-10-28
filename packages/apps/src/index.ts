import type { NameEntry } from '@beacon/core'
import { NameIndexProvider } from '@beacon/core'
import type { AppEntry } from './types'
import { launch } from './launch'
import { discoverLinux } from './linux'
import { discoverMac, type MacOptions } from './macos'
import { discoverWindows, type WinOptions } from './windows'

export * from './types'
export * from './linux'
export * from './macos'
export * from './windows'
export * from './launch'

export type Platform = 'linux' | 'darwin' | 'win32'

export async function discoverApps(
  platform: Platform = process.platform as Platform,
  opts: {
    convertPlist?: MacOptions['convertPlist']
    getStartApps?: WinOptions['getStartApps']
  } = {},
): Promise<AppEntry[]> {
  if (platform === 'linux') return discoverLinux()
  if (platform === 'darwin') return discoverMac(opts)
  return discoverWindows(opts)
}

/**
 * Apps provider with incremental refresh: `replaceSource` swaps only the entries from
 * one root, so a watcher event never forces a full rescan.
 */
export class AppsProvider extends NameIndexProvider {
  private bySource = new Map<string, AppEntry[]>()
  readonly byId = new Map<string, AppEntry>()

  constructor() {
    super('apps', 'Applications')
  }

  async activate(itemId: string, actionId?: string): Promise<void> {
    const e = this.byId.get(itemId)
    if (!e) throw new Error('unknown app')
    const spec = actionId ? e.actions.find((a) => a.id === actionId)?.launch : e.launch
    if (!spec) throw new Error('unknown action')
    await launch(spec)
  }

  setAll(entries: AppEntry[]): void {
    this.bySource.clear()
    for (const e of entries) {
      const l = this.bySource.get(e.source) ?? []
      l.push(e)
      this.bySource.set(e.source, l)
    }
    this.rebuild()
  }

  replaceSource(source: string, entries: AppEntry[]): void {
    this.bySource.set(source, entries)
    this.rebuild()
  }

  private rebuild(): void {
    this.byId.clear()
    const list: NameEntry[] = []
    for (const entries of this.bySource.values())
      for (const e of entries) {
        if (this.byId.has(e.id)) continue
        this.byId.set(e.id, e)
        list.push({
          id: e.id,
          title: e.name,
          kind: 'app',
          keywords: e.keywords,
          ...(e.iconPath ? { icon: e.iconPath } : {}),
          actions: e.actions.map((a) => ({
            id: a.id,
            title: a.title,
            kind: 'custom' as const,
            payload: null,
          })),
          primary: { id: 'launch', title: 'Open', kind: 'open', payload: e.launch },
        })
      }
    this.set(list)
  }
}
export * from './watch'
