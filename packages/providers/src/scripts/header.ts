import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

export type OutputMode = 'inline' | 'list' | 'copy' | 'silent' | 'terminal'
export type ArgType =
  'text' | 'number' | 'choice' | 'file' | 'folder' | 'clipboard' | 'selection' | 'secret'

export interface ArgSpec {
  name: string
  type: ArgType
  choices?: string[]
  optional: boolean
  default?: string
  prompt?: string
}

export interface ScriptMeta {
  title?: string
  desc?: string
  keyword?: string
  icon?: string
  output: OutputMode
  args: ArgSpec[]
  timeoutSec?: number
  confirm: boolean
  os?: string[]
  ssh?: string
  /** Save this script's output into run history (off by default; scripts may print secrets). */
  saveOutput: boolean
  stdin?: 'clipboard' | 'selection'
}

export const OUTPUT_MODES: OutputMode[] = ['inline', 'list', 'copy', 'silent', 'terminal']
const ARG_TYPES: ArgType[] = [
  'text',
  'number',
  'choice',
  'file',
  'folder',
  'clipboard',
  'selection',
  'secret',
]

/**
 * Parse one `@beacon.arg` value: `name:type(opts)?=default "prompt"`
 *   target:choice(nas,usb)=nas  "Where to?"   |   note:text?  "Optional note"   |   pw:secret
 */
export function parseArgSpec(s: string): ArgSpec | null {
  const m =
    /^([A-Za-z_][\w-]*):([a-z]+)(?:\(([^)]*)\))?(\?)?(?:=("[^"]*"|\S+))?\s*(?:"([^"]*)")?\s*$/.exec(
      s.trim(),
    )
  if (!m) return null
  const type = m[2] as ArgType
  if (!ARG_TYPES.includes(type)) return null
  const spec: ArgSpec = { name: m[1] as string, type, optional: m[4] === '?' }
  if (type === 'choice') {
    const choices = (m[3] ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
    if (!choices.length) return null
    spec.choices = choices
  }
  if (m[5] !== undefined) spec.default = m[5].replace(/^"|"$/g, '')
  if (m[6]) spec.prompt = m[6]
  if (spec.default !== undefined) spec.optional = true
  return spec
}

const LINE =
  /^\s*(?:#|\/\/|--|;|::|REM\b|\*|\/\*+|<!--|%)+\s*@beacon\.([a-z][a-z.-]*)\s*(.*?)\s*(?:\*\/|-->)?\s*$/i

const bool = (v: string) => /^(true|yes|1|on)$/i.test(v)

/** Apply one key/value (from a header line or a sidecar) onto `meta`. Unknown keys are ignored. */
function apply(meta: ScriptMeta, key: string, value: string): void {
  switch (key.toLowerCase()) {
    case 'title':
      meta.title = value || undefined
      break
    case 'desc':
    case 'description':
      meta.desc = value || undefined
      break
    case 'keyword':
      meta.keyword = value.split(/\s+/)[0] || undefined
      break
    case 'icon':
      meta.icon = value || undefined
      break
    case 'output':
      if ((OUTPUT_MODES as string[]).includes(value.toLowerCase()))
        meta.output = value.toLowerCase() as OutputMode
      break
    case 'arg': {
      const a = parseArgSpec(value)
      if (a) meta.args.push(a)
      break
    }
    case 'timeout': {
      const n = Number(value)
      if (Number.isFinite(n) && n > 0 && n <= 86_400) meta.timeoutSec = n
      break
    }
    case 'confirm':
      meta.confirm = bool(value)
      break
    case 'os':
      meta.os = value
        .split(/[\s,]+/)
        .map((o) => o.toLowerCase())
        .filter(Boolean)
      break
    case 'ssh':
      if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) meta.ssh = value
      break
    case 'save-output':
    case 'saveoutput':
      meta.saveOutput = bool(value)
      break
    case 'stdin':
      if (value === 'clipboard' || value === 'selection') meta.stdin = value
      break
  }
}

export const emptyMeta = (): ScriptMeta => ({
  output: 'inline',
  args: [],
  confirm: false,
  saveOutput: false,
})

/** Header comments in any comment style. Missing/bad headers fall back to defaults (filename is the title). */
export function parseHeader(text: string): ScriptMeta {
  const meta = emptyMeta()
  const lines = text.split(/\r?\n/).slice(0, 80)
  for (const line of lines) {
    const m = LINE.exec(line)
    if (m) apply(meta, m[1] as string, m[2] as string)
  }
  return meta
}

/** Sidecar `<script>.beacon.json` for languages without comments. Same keys; `args` is a list of spec strings. */
export function parseSidecar(json: string): ScriptMeta | null {
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const meta = emptyMeta()
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k === 'args') {
      if (Array.isArray(val)) for (const a of val) if (typeof a === 'string') apply(meta, 'arg', a)
    } else if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean')
      apply(meta, k, String(val))
    else if (Array.isArray(val)) apply(meta, k, val.join(','))
  }
  return meta
}

export async function readMeta(file: string): Promise<{ meta: ScriptMeta; head: string }> {
  let text = ''
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return { meta: emptyMeta(), head: '' }
  }
  const sidecar = await fs
    .readFile(join(dirname(file), basename(file, extname(file)) + '.beacon.json'), 'utf8')
    .catch(() => undefined)
  const meta = (sidecar ? parseSidecar(sidecar) : null) ?? parseHeader(text)
  return { meta, head: text.slice(0, 4096) }
}

/** Title from the filename when no @beacon.title: "backup_home-lab.sh" → "backup home lab". */
export const titleFromFile = (file: string): string =>
  basename(file, extname(file)).replace(/[_-]+/g, ' ').trim() || basename(file)
