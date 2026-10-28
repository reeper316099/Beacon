import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import type { AppEntry } from './types'

export interface WinOptions {
  dirs?: string[]
  /** Run PowerShell Get-StartApps → JSON text. Injected; real impl spawns powershell with argv. */
  getStartApps?: () => Promise<string | undefined>
  env?: Record<string, string | undefined>
}

export function winStartMenuDirs(env: Record<string, string | undefined> = process.env): string[] {
  const dirs: string[] = []
  if (env['ProgramData'])
    dirs.push(join(env['ProgramData'], 'Microsoft/Windows/Start Menu/Programs'))
  if (env['APPDATA']) dirs.push(join(env['APPDATA'], 'Microsoft/Windows/Start Menu/Programs'))
  return dirs
}

async function walkLnk(dir: string): Promise<string[]> {
  let ents
  try {
    ents = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walkLnk(p)))
    else if (/\.lnk$/i.test(e.name) && !/uninstall/i.test(e.name)) out.push(p)
  }
  return out
}

/** Parse `Get-StartApps | ConvertTo-Json` output (object or array). */
export function parseStartApps(json: string): { name: string; appId: string }[] {
  try {
    const v = JSON.parse(json) as unknown
    const arr = Array.isArray(v) ? v : [v]
    return arr
      .filter(
        (x): x is { Name: string; AppID: string } =>
          !!x && typeof x.Name === 'string' && typeof x.AppID === 'string',
      )
      .map((x) => ({ name: x.Name, appId: x.AppID }))
  } catch {
    return []
  }
}

export async function discoverWindows(opts: WinOptions = {}): Promise<AppEntry[]> {
  const out: AppEntry[] = []
  const seenNames = new Set<string>()
  for (const dir of opts.dirs ?? winStartMenuDirs(opts.env)) {
    for (const lnk of (await walkLnk(dir)).sort()) {
      const name = basename(lnk).replace(/\.lnk$/i, '')
      seenNames.add(name.toLowerCase())
      out.push({
        id: lnk,
        name,
        keywords: [],
        launch: { file: 'explorer.exe', args: [lnk] },
        iconPath: lnk,
        source: dir,
        actions: [],
      })
    }
  }
  const json = await opts.getStartApps?.()
  if (json) {
    for (const a of parseStartApps(json)) {
      // Packaged apps have AppIDs like "Publisher.App_xxx!App"; classic entries are already covered by .lnk files.
      if (!a.appId.includes('!') || seenNames.has(a.name.toLowerCase())) continue
      out.push({
        id: `uwp:${a.appId}`,
        name: a.name,
        keywords: [],
        launch: { file: 'explorer.exe', args: [`shell:AppsFolder\\${a.appId}`] },
        source: 'uwp',
        actions: [],
      })
    }
  }
  return out
}
