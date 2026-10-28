import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'
import type { AppEntry, LaunchSpec } from './types'

export interface LinuxEnv {
  XDG_DATA_HOME?: string
  XDG_DATA_DIRS?: string
  XDG_CURRENT_DESKTOP?: string
  LANG?: string
  HOME?: string
}

export interface LinuxOptions {
  env?: LinuxEnv
  /** Terminal launcher for Terminal=true entries, e.g. ['xterm','-e']. */
  terminal?: string[]
  /** Override scanned application dirs (tests). */
  dirs?: string[]
}

type Section = Record<string, string>

export function parseDesktopFile(text: string): Record<string, Section> {
  const out: Record<string, Section> = {}
  let cur: Section | null = null
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim()
    if (!l || l.startsWith('#')) continue
    const sec = /^\[(.+)\]$/.exec(l)
    if (sec) {
      cur = out[sec[1] as string] = {}
      continue
    }
    const eq = l.indexOf('=')
    if (cur && eq > 0) cur[l.slice(0, eq).trim()] = l.slice(eq + 1).trim()
  }
  return out
}

/** Split an Exec value per the Desktop Entry spec (double quotes, backslash escapes). */
export function splitExec(exec: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  let has = false
  for (let i = 0; i < exec.length; i++) {
    const ch = exec[i] as string
    if (inQ) {
      if (ch === '\\' && i + 1 < exec.length) cur += exec[++i]
      else if (ch === '"') inQ = false
      else cur += ch
    } else if (ch === '"') {
      inQ = true
      has = true
    } else if (ch === ' ' || ch === '\t') {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (has || cur) out.push(cur)
  return out
}

/** Strip/expand Exec field codes. Returns argv. */
export function expandExec(
  exec: string,
  ctx: { name: string; icon?: string; path?: string },
): string[] {
  const out: string[] = []
  for (const tok of splitExec(exec)) {
    if (/^%[fFuUdDnNvm]$/.test(tok)) continue
    if (tok === '%i') {
      if (ctx.icon) out.push('--icon', ctx.icon)
      continue
    }
    let t = ''
    for (let i = 0; i < tok.length; i++) {
      if (tok[i] === '%' && i + 1 < tok.length) {
        const c = tok[++i] as string
        if (c === '%') t += '%'
        else if (c === 'c') t += ctx.name
        else if (c === 'k') t += ctx.path ?? ''
        // other codes (%f %u ...) embedded in a larger token are dropped
      } else t += tok[i]
    }
    if (t !== '' || tok === '""') out.push(t)
  }
  return out
}

function localized(sec: Section, key: string, lang: string | undefined): string | undefined {
  if (lang) {
    const l = lang.split('.')[0] as string // en_US
    const short = l.split('_')[0] as string
    for (const k of [`${key}[${l}]`, `${key}[${short}]`]) if (sec[k]) return sec[k]
  }
  return sec[key]
}

const list = (v: string | undefined): string[] => (v ? v.split(';').filter(Boolean) : [])

export function entryFromDesktop(
  id: string,
  path: string,
  text: string,
  opts: LinuxOptions = {},
): AppEntry | null {
  const env = opts.env ?? {}
  const sections = parseDesktopFile(text)
  const d = sections['Desktop Entry']
  if (!d || d['Type'] !== 'Application') return null
  if (d['NoDisplay'] === 'true' || d['Hidden'] === 'true') return null
  const desktops = list(env.XDG_CURRENT_DESKTOP?.replace(/:/g, ';'))
  const only = list(d['OnlyShowIn'])
  const not = list(d['NotShowIn'])
  if (only.length && !only.some((x) => desktops.includes(x))) return null
  if (not.some((x) => desktops.includes(x))) return null
  const name = localized(d, 'Name', env.LANG)
  const exec = d['Exec']
  if (!name || !exec) return null

  const build = (execLine: string, sec: Section): LaunchSpec | null => {
    const argv = expandExec(execLine, { name, ...(sec['Icon'] ? { icon: sec['Icon'] } : {}), path })
    if (argv.length === 0) return null
    if (d['Terminal'] === 'true') argv.unshift(...(opts.terminal ?? ['xterm', '-e']))
    return { file: argv[0] as string, args: argv.slice(1) }
  }
  const launch = build(exec, d)
  if (!launch) return null

  const actions = []
  for (const aid of list(d['Actions'])) {
    const a = sections[`Desktop Action ${aid}`]
    const an = a && localized(a, 'Name', env.LANG)
    const ae = a?.['Exec']
    if (!a || !an || !ae) continue
    const l = build(ae, d)
    if (l) actions.push({ id: aid, title: an, launch: l })
  }
  const entry: AppEntry = {
    id,
    name,
    keywords: [...list(localized(d, 'Keywords', env.LANG)), ...list(d['GenericName'])],
    launch,
    source: path,
    actions,
  }
  if (d['Icon']) entry.iconPath = d['Icon']
  return entry
}

export function linuxAppDirs(env: LinuxEnv = process.env): string[] {
  const home = env.HOME ?? homedir()
  const dataHome = env.XDG_DATA_HOME || join(home, '.local/share')
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean)
  return [
    join(dataHome, 'applications'),
    ...dataDirs.map((d) => join(d, 'applications')),
    join(home, '.local/share/flatpak/exports/share/applications'),
    '/var/lib/flatpak/exports/share/applications',
    '/var/lib/snapd/desktop/applications',
  ]
}

async function walk(dir: string): Promise<string[]> {
  let ents
  try {
    ents = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else if (e.name.endsWith('.desktop')) out.push(p)
  }
  return out
}

/** Scan dirs in priority order; the first file with a given desktop-file id wins. */
export async function discoverLinux(opts: LinuxOptions = {}): Promise<AppEntry[]> {
  const dirs = opts.dirs ?? linuxAppDirs(opts.env)
  const seen = new Set<string>()
  const out: AppEntry[] = []
  for (const dir of dirs) {
    for (const file of (await walk(dir)).sort()) {
      const id = relative(dir, file).replace(/\//g, '-')
      if (seen.has(id)) continue
      seen.add(id)
      let text
      try {
        text = await fs.readFile(file, 'utf8')
      } catch {
        continue
      }
      const e = entryFromDesktop(id, file, text, opts)
      if (e) out.push(e)
    }
  }
  return out
}

const ICON_EXT = ['.png', '.svg', '.xpm']

/** Resolve an icon name to a file via hicolor/pixmaps; undefined → caller uses a letter icon. */
export async function resolveLinuxIcon(
  icon: string,
  dataDirs: string[],
): Promise<string | undefined> {
  if (icon.startsWith('/')) return icon
  const sizes = ['256x256', '128x128', '64x64', '48x48', '32x32', 'scalable']
  for (const base of dataDirs) {
    for (const size of sizes)
      for (const ext of ICON_EXT) {
        const p = join(base, 'icons/hicolor', size, 'apps', icon + ext)
        try {
          await fs.access(p)
          return p
        } catch {
          /* next */
        }
      }
    for (const ext of ICON_EXT) {
      const p = join(base, 'pixmaps', icon + ext)
      try {
        await fs.access(p)
        return p
      } catch {
        /* next */
      }
    }
  }
  return undefined
}

export const _basename = basename
