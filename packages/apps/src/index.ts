import type { NameEntry } from '@beacon/core'
import { NameIndexProvider } from '@beacon/core'
import type { AppEntry } from './types'
import { discoverLinux } from './linux'
import { discoverMac } from './macos'
import { discoverWindows } from './windows'

export * from './types'
export * from './linux'
export * from './macos'
export * from './windows'
export * from './launch'

export type Platform = 'linux' | 'darwin' | 'win32'

export async function discoverApps(
  platform: Platform = process.platform as Platform,
): Promise<AppEntry[]> {
  if (platform === 'linux') return discoverLinux()
  if (platform === 'darwin') return discoverMac()
  return discoverWindows()
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
          primary: { id: 'launch', title: 'Open', kind: 'open', payload: e.launch },
        })
      }
    this.set(list)
  }
}
export * from './watch'
