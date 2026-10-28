import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** Default data dir for an app, honouring its env override. */
export function defaultDataDir(
  env: string,
  folder: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const o = process.env[env]
  if (o) return o
  if (platform === 'darwin') return join(homedir(), 'Library/Application Support', folder)
  if (platform === 'win32')
    return join(process.env['APPDATA'] ?? join(homedir(), 'AppData/Roaming'), folder)
  return join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), folder)
}

export async function readJson(
  file: string,
): Promise<
  { ok: true; value: unknown } | { ok: false; reason: 'missing' | 'invalid' | 'encrypted' }
> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return { ok: false, reason: 'missing' }
  }
  const head = text.slice(0, 200)
  if (/"(classpad|cipherkeep)"\s*:\s*"enc/.test(head) || text.startsWith('CKENC'))
    return { ok: false, reason: 'encrypted' }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}

/** Items from either a bare array or the `{ schemaVersion, items | data.items }` wrapper. */
export function unwrapItems(v: unknown): { items: unknown[]; schemaVersion?: number } {
  if (Array.isArray(v)) return { items: v }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const sv = typeof o['schemaVersion'] === 'number' ? o['schemaVersion'] : undefined
    const inner =
      o['items'] ??
      (o['data'] && typeof o['data'] === 'object'
        ? (o['data'] as Record<string, unknown>)['items']
        : undefined)
    if (Array.isArray(inner))
      return { items: inner, ...(sv !== undefined ? { schemaVersion: sv } : {}) }
  }
  return { items: [] }
}

export async function listFiles(dir: string, ext: string): Promise<string[]> {
  let ents
  try {
    ents = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await listFiles(p, ext)))
    else if (e.name.endsWith(ext) && !e.name.startsWith('.')) out.push(p)
  }
  return out.sort()
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** Split `---` YAML frontmatter from a Markdown file. Returns null when absent or unparsable. */
export function frontmatter(text: string): { data: Record<string, unknown>; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return null
  try {
    const data = parseYaml(m[1] as string)
    return data && typeof data === 'object'
      ? { data: data as Record<string, unknown>, body: m[2] as string }
      : null
  } catch {
    return null
  }
}

export const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v : undefined
export const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
