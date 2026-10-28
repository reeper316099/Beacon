import { promises as fs } from 'node:fs'
import { delimiter, extname, join } from 'node:path'

export interface Interpreter {
  file: string
  /** Args placed before the script path. */
  args: string[]
}

export interface InterpreterConfig {
  /** Per-extension override, e.g. { ".py": "/opt/venv/bin/python" } (first word is the program). */
  byExt?: Record<string, string>
  /** Runner for .ts files, e.g. ["tsx"] or ["bun"]. */
  tsRunner?: string[]
}

export const SCRIPT_EXTS = new Set([
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.bat',
  '.cmd',
  '.rb',
  '.pl',
])

export async function findInPath(
  bin: string,
  path = process.env['PATH'] ?? '',
  platform = process.platform,
): Promise<string | null> {
  if (bin.includes('/') || bin.includes('\\'))
    return (await fs.access(bin).then(
      () => true,
      () => false,
    ))
      ? bin
      : null
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const d of path.split(delimiter).filter(Boolean))
    for (const e of exts) {
      const p = join(d, bin + e)
      if (
        await fs.access(p).then(
          () => true,
          () => false,
        )
      )
        return p
    }
  return null
}

export function parseShebang(head: string): string[] | null {
  const m = /^#!\s*(\S.*?)\s*\r?\n/.exec(head.startsWith('#!') ? head : '')
  if (!m) return null
  const parts = (m[1] as string).split(/\s+/)
  if (/\/env$/.test(parts[0] as string)) {
    const rest = parts.slice(1).filter((p) => p !== '-S')
    return rest.length ? rest : null
  }
  return parts
}

const DEFAULTS: Record<string, { candidates: string[]; args?: string[] }> = {
  '.py': { candidates: ['python3', 'python', 'py'] },
  '.js': { candidates: ['node'] },
  '.mjs': { candidates: ['node'] },
  '.cjs': { candidates: ['node'] },
  '.sh': { candidates: ['bash', 'sh'] },
  '.bash': { candidates: ['bash'] },
  '.zsh': { candidates: ['zsh'] },
  '.ps1': { candidates: ['pwsh', 'powershell'], args: ['-NoProfile', '-NonInteractive', '-File'] },
  '.rb': { candidates: ['ruby'] },
  '.pl': { candidates: ['perl'] },
}

/**
 * Pick the program that runs a script. Precedence: shebang, then a configured override, then
 * auto-detected defaults for the extension. Returns an error string when nothing usable is found.
 */
export async function resolveInterpreter(
  scriptPath: string,
  head: string,
  cfg: InterpreterConfig = {},
  executable = false,
  platform: NodeJS.Platform = process.platform,
  find: (bin: string) => Promise<string | null> = (b) => findInPath(b),
): Promise<Interpreter | { error: string }> {
  const ext = extname(scriptPath).toLowerCase()
  if (platform === 'win32' && (ext === '.bat' || ext === '.cmd'))
    return { file: 'cmd.exe', args: ['/d', '/s', '/c'] }

  const she = parseShebang(head)
  if (she && (platform !== 'win32' || !she[0]?.startsWith('/'))) {
    const prog = she[0] as string
    if (platform === 'win32') {
      const base = prog.split('/').pop() as string
      const f = await find(base)
      if (f) return { file: f, args: she.slice(1) }
    } else if (await find(prog)) return { file: prog, args: she.slice(1) }
    else return { error: `shebang interpreter not found: ${prog}` }
  }
  const override = cfg.byExt?.[ext]
  if (override) {
    const [prog, ...rest] = override.split(/\s+/)
    const f = prog ? await find(prog) : null
    return f ? { file: f, args: rest } : { error: `configured interpreter not found: ${prog}` }
  }
  if (ext === '.ts') {
    const [prog, ...rest] = cfg.tsRunner ?? ['tsx']
    const f = prog ? await find(prog) : null
    return f
      ? { file: f, args: rest }
      : { error: 'no TypeScript runner: set tsRunner (e.g. ["tsx"]) in config/scripts.json' }
  }
  const d = DEFAULTS[ext]
  if (d) {
    for (const c of d.candidates) {
      const f = await find(c)
      if (f) return { file: f, args: d.args ?? [] }
    }
    return { error: `no interpreter found for ${ext} (tried ${d.candidates.join(', ')})` }
  }
  if (executable && platform !== 'win32') return { file: scriptPath, args: [] } // runs itself
  return { error: `don't know how to run ${ext || 'this file'}` }
}

/** Minimal environment: no Beacon internals, no tokens. Extra vars only via the allow-list. */
export function buildEnv(
  allow: string[] = [],
  extraPath: string[] = [],
  src: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  extra: Record<string, string> = {},
): Record<string, string> {
  const base = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'TZ',
    'SHELL',
  ]
  const win = [
    'SystemRoot',
    'SYSTEMROOT',
    'ComSpec',
    'PATHEXT',
    'USERPROFILE',
    'USERNAME',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'windir',
  ]
  const out: Record<string, string> = {}
  for (const k of [...base, ...(platform === 'win32' ? win : []), ...allow]) {
    if (/^(BEACON|ELECTRON)/i.test(k)) continue
    const v = src[k]
    if (v !== undefined) out[k] = v
  }
  if (extraPath.length)
    out['PATH'] = [...extraPath, out['PATH'] ?? ''].filter(Boolean).join(delimiter)
  return { ...out, ...extra, TERM: 'dumb', NO_COLOR: out['NO_COLOR'] ?? '' } as Record<
    string,
    string
  >
}

/** POSIX single-quote a word (used only for `ssh host cmd...`, where the remote shell re-parses). */
export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** cmd.exe re-parses arguments; refuse anything that could be interpreted. */
export const SAFE_CMD_ARG = /^[^&|<>^%"!()\r\n]*$/
