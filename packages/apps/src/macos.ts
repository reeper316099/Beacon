import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { AppEntry } from './types'

export function parsePlistXml(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g
  let m
  while ((m = re.exec(text))) out[unescapeXml(m[1] as string)] = unescapeXml(m[2] as string)
  return out
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export interface MacOptions {
  dirs?: string[]
  /** Convert a binary plist to XML (plutil); injected for tests. Returns undefined on failure. */
  convertPlist?: (path: string) => Promise<string | undefined>
}

export function macAppDirs(): string[] {
  return [
    '/Applications',
    '/System/Applications',
    '/System/Applications/Utilities',
    '/Applications/Utilities',
    '/System/Cryptexes/App/System/Applications',
    join(homedir(), 'Applications'),
  ]
}

async function readInfo(app: string, opts: MacOptions): Promise<Record<string, string>> {
  const p = join(app, 'Contents/Info.plist')
  let buf: Buffer
  try {
    buf = await fs.readFile(p)
  } catch {
    return {}
  }
  if (buf.subarray(0, 6).toString() === 'bplist') {
    const xml = await opts.convertPlist?.(p)
    return xml ? parsePlistXml(xml) : {}
  }
  return parsePlistXml(buf.toString('utf8'))
}

export async function discoverMac(opts: MacOptions = {}): Promise<AppEntry[]> {
  const out: AppEntry[] = []
  const seen = new Set<string>()
  const seenBundles = new Set<string>()
  for (const dir of opts.dirs ?? macAppDirs()) {
    let ents
    try {
      ents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      if (!e.name.endsWith('.app')) continue
      const path = join(dir, e.name)
      if (seen.has(path)) continue
      seen.add(path)
      const info = await readInfo(path, opts)
      if (info['LSUIElement'] === '1' || info['LSBackgroundOnly'] === '1') continue
      // The same app can appear under /Applications and a Cryptex path; keep the first.
      const bundleId = info['CFBundleIdentifier']
      if (bundleId) {
        if (seenBundles.has(bundleId)) continue
        seenBundles.add(bundleId)
      }
      const name = info['CFBundleDisplayName'] || info['CFBundleName'] || basename(e.name, '.app')
      const entry: AppEntry = {
        id: path,
        name,
        keywords: [],
        launch: { file: 'open', args: [path] },
        iconPath: path,
        source: dir,
        actions: [
          { id: 'reveal', title: 'Reveal in Finder', launch: { file: 'open', args: ['-R', path] } },
        ],
      }
      out.push(entry)
    }
  }
  return out
}
