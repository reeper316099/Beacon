import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import chokidar from 'chokidar'
import type { Effects } from '@beacon/shared'
import { SAFE_HOST, terminalRun, type TerminalConfig } from '../terminal'
import { spawnArgv } from '../base'
import { stripAnsi } from './ansi'
import { readMeta, titleFromFile, type ArgSpec, type ScriptMeta } from './header'
import {
  SAFE_CMD_ARG,
  SCRIPT_EXTS,
  buildEnv,
  resolveInterpreter,
  shQuote,
  type Interpreter,
} from './interpreter'
import { runProcess, type ControlMessage, type RunResult } from './runner'
import { ScriptTrust, hashContent } from './trust'

export interface ScriptFolder {
  path: string
  interpreters?: Record<string, string>
  cwd?: string
  env?: string[]
  extraPath?: string[]
}

export interface ScriptsConfig {
  folders: ScriptFolder[]
  envAllow: string[]
  extraPath: string[]
  timeoutSec: number
  maxOutputBytes: number
  concurrency: number
  /** Record run metadata (time, script, exit code, duration). Output is never saved unless a script opts in. */
  history: boolean
  tsRunner?: string[]
  terminal?: TerminalConfig
}

export const DEFAULT_SCRIPTS_CONFIG: ScriptsConfig = {
  folders: [],
  envAllow: [],
  extraPath: [],
  timeoutSec: 30,
  maxOutputBytes: 1_048_576,
  concurrency: 4,
  history: false,
}

export interface ScriptEntry {
  id: string
  path: string
  folder: ScriptFolder
  /** Subfolder path relative to the script folder: scripts in subfolders form groups. */
  group: string
  meta: ScriptMeta
  title: string
  executable: boolean
  head: string
}

export const scriptId = (path: string): string =>
  's' + createHash('sha1').update(path).digest('hex').slice(0, 10)
const osName = (p: NodeJS.Platform) =>
  p === 'darwin' ? 'macos' : p === 'win32' ? 'windows' : 'linux'

// ---------- discovery ----------

async function walk(dir: string, depth = 0): Promise<string[]> {
  if (depth > 6) return []
  let ents
  try {
    ents = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p, depth + 1)))
    else if (e.isFile()) out.push(p)
  }
  return out.sort()
}

export async function scanScripts(
  cfg: ScriptsConfig,
  platform: NodeJS.Platform = process.platform,
): Promise<ScriptEntry[]> {
  const out: ScriptEntry[] = []
  const seen = new Set<string>()
  for (const folder of cfg.folders) {
    for (const path of await walk(folder.path)) {
      if (seen.has(path) || path.endsWith('.beacon.json')) continue
      const ext = extname(path).toLowerCase()
      let executable = false
      if (!SCRIPT_EXTS.has(ext)) {
        // Any file with an executable bit and a shebang is a script too.
        if (platform === 'win32') continue
        try {
          executable = ((await fs.stat(path)).mode & 0o111) !== 0
        } catch {
          continue
        }
        if (!executable) continue
      }
      const { meta, head } = await readMeta(path)
      if (!SCRIPT_EXTS.has(ext) && !head.startsWith('#!')) continue
      if (meta.os && !meta.os.includes(osName(platform))) continue
      seen.add(path)
      out.push({
        id: scriptId(path),
        path,
        folder,
        head,
        executable,
        group: relative(folder.path, dirname(path)).split(sep).filter(Boolean).join(' / '),
        meta,
        title: meta.title ?? titleFromFile(path),
      })
    }
  }
  return out
}

/** Hot reload: rescan when files in script folders are added, edited or removed. */
export function watchScripts(
  folders: string[],
  onChange: () => void,
  debounceMs = 300,
): () => Promise<void> {
  let t: NodeJS.Timeout | undefined
  const w = chokidar.watch(folders, {
    ignoreInitial: true,
    depth: 6,
    ignored: (p) =>
      /(^|[\\/])(\.|node_modules)/.test(basename(p)) &&
      basename(p) !== '' &&
      p !== folders.find((f) => f === p),
  })
  w.on('all', () => {
    clearTimeout(t)
    t = setTimeout(onChange, debounceMs)
  })
  w.on('error', () => {})
  return async () => {
    clearTimeout(t)
    await w.close()
  }
}

// ---------- arguments ----------

export interface ArgInput {
  given: Record<string, string>
  clipboard: () => Promise<string>
  selection?: string
}

export type ArgResult =
  { ok: true; argv: string[] } | { ok: false; missing: ArgSpec[]; error?: string }

/** Turn the spec + user input into argv. Secrets must be supplied on every run; nothing here stores them. */
export async function resolveArgs(specs: ArgSpec[], inp: ArgInput): Promise<ArgResult> {
  const values: string[] = []
  const missing: ArgSpec[] = []
  let error: string | undefined
  for (const s of specs) {
    let v: string | undefined = inp.given[s.name]
    if (v === undefined || v === '') {
      if (s.type === 'clipboard') v = await inp.clipboard()
      else if (s.type === 'selection') v = inp.selection
      else if (s.type !== 'secret') v = s.default
    }
    if (v === undefined || v === '') {
      if (!s.optional) missing.push(s)
      values.push('')
      continue
    }
    let bad: string | undefined
    if (s.type === 'number' && !Number.isFinite(Number(v))) bad = `${s.name} must be a number`
    else if (s.type === 'choice' && !s.choices?.includes(v))
      bad = `${s.name} must be one of ${s.choices?.join(', ')}`
    else if ((s.type === 'file' || s.type === 'folder') && !isAbsolute(v))
      bad = `${s.name} must be an absolute path`
    if (bad) {
      error = bad
      missing.push(s)
    }
    values.push(v)
  }
  if (missing.length) return { ok: false, missing, ...(error ? { error } : {}) }
  while (values.length && values[values.length - 1] === '') values.pop()
  return { ok: true, argv: values }
}

/** Assign words typed after the keyword to the (typeable) args in order: `bk nas "weekly"`. */
export function assignTyped(specs: ArgSpec[], words: string[]): Record<string, string> {
  const typeable = specs.filter((s) => !['clipboard', 'selection', 'secret'].includes(s.type))
  const out: Record<string, string> = {}
  typeable.forEach((s, i) => {
    if (words[i] !== undefined)
      out[s.name] = i === typeable.length - 1 ? words.slice(i).join(' ') : (words[i] as string)
  })
  return out
}

// ---------- list mode ----------

export interface ListLine {
  title: string
  subtitle?: string
  icon?: string
  value?: string
  action?: string
}

/** JSON Lines → items. Malformed lines and lines without a title are skipped. */
export function parseJsonLines(text: string, max = 100): ListLine[] {
  const out: ListLine[] = []
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      if (typeof o['title'] !== 'string' || !o['title']) continue
      const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined)
      out.push({
        title: o['title'].slice(0, 300),
        ...(s('subtitle') ? { subtitle: s('subtitle')!.slice(0, 300) } : {}),
        ...(s('icon') ? { icon: s('icon')!.slice(0, 8) } : {}),
        ...(s('value') !== undefined ? { value: s('value')!.slice(0, 5000) } : {}),
        ...(s('action') ? { action: s('action')!.slice(0, 200) } : {}),
      })
      if (out.length >= max) break
    } catch {
      /* malformed line */
    }
  }
  return out
}

// ---------- running ----------

export type ScriptEvent =
  | {
      ev: 'confirm'
      title: string
      path: string
      interpreter: string
      reasons: string[]
      review: { kind: 'new' | 'changed'; text: string }
      hash: string
      needsTrust: boolean
    }
  | {
      ev: 'need-args'
      title: string
      specs: ArgSpec[]
      values: Record<string, string>
      error?: string
    }
  | { ev: 'start'; title: string; mode: ScriptMeta['output'] }
  | { ev: 'out'; stream: 'stdout' | 'stderr'; text: string }
  | { ev: 'progress'; value?: number; label?: string }
  | ({ ev: 'exit'; mode: ScriptMeta['output'] } & RunResult)
  | { ev: 'toast'; message: string }
  | { ev: 'error'; message: string }

export interface RunRequest {
  scriptId: string
  args?: Record<string, string>
  /** The content hash the user just approved in the confirm panel. */
  trustHash?: string
  confirmed?: boolean
  selection?: string
}

export interface ManagerDeps {
  cfg: () => ScriptsConfig
  entries: () => ScriptEntry[]
  trust: ScriptTrust
  effects: () => Effects | undefined
  historyFile?: string
  platform?: NodeJS.Platform
  sshHosts?: () => Promise<string[]>
  onRunningChange?: (n: number) => void
  now?: () => number
}

export class ScriptManager {
  private active = new Map<string, { cancel(): void }>()
  constructor(private d: ManagerDeps) {}

  get running(): number {
    return this.active.size
  }

  cancel(runId: string): void {
    this.active.get(runId)?.cancel()
  }

  private async prepare(
    entry: ScriptEntry,
    req: RunRequest,
  ): Promise<{ hash: string; content: string; interp: Interpreter | { error: string } }> {
    const buf = await fs.readFile(entry.path)
    const interp = await resolveInterpreter(
      entry.path,
      buf.toString('utf8', 0, 4096),
      { byExt: entry.folder.interpreters, tsRunner: this.d.cfg().tsRunner },
      entry.executable,
      this.d.platform,
    )
    void req
    return { hash: hashContent(buf), content: buf.toString('utf8'), interp }
  }

  /** The interactive path: events go to `post` (the launcher's output panel). */
  async run(runId: string, req: RunRequest, post: (e: ScriptEvent) => void): Promise<void> {
    const entry = this.d.entries().find((e) => e.id === req.scriptId)
    if (!entry) return post({ ev: 'error', message: 'script not found (was it moved or deleted?)' })
    const cfg = this.d.cfg()
    const platform = this.d.platform ?? process.platform
    let prep
    try {
      prep = await this.prepare(entry, req)
    } catch {
      return post({ ev: 'error', message: 'could not read the script' })
    }
    if ('error' in prep.interp) return post({ ev: 'error', message: prep.interp.error })
    const interp = prep.interp

    // Trust-on-first-use, per content hash.
    const trusted = this.d.trust.isTrusted(entry.path, prep.hash)
    const reasons: string[] = []
    if (!trusted)
      reasons.push(
        this.d.trust.hasHistory(entry.path)
          ? 'This script changed since you last trusted it.'
          : 'First run of this script.',
      )
    if (entry.meta.confirm) reasons.push('This script asks for confirmation before every run.')
    if (entry.meta.ssh)
      reasons.push(`This will run on the remote host "${entry.meta.ssh}" over ssh.`)
    const approved = req.confirmed === true && req.trustHash === prep.hash
    if (reasons.length && !approved) {
      const review = await this.d.trust.review(entry.path, prep.content)
      return post({
        ev: 'confirm',
        title: entry.title,
        path: entry.path,
        interpreter: [interp.file, ...interp.args].join(' '),
        reasons,
        review,
        hash: prep.hash,
        needsTrust: !trusted,
      })
    }
    if (!trusted) await this.d.trust.trust(entry.path, prep.hash, prep.content)

    // Arguments.
    const fx = this.d.effects()
    const ra = await resolveArgs(entry.meta.args, {
      given: req.args ?? {},
      clipboard: () => (fx ? fx.readClipboard() : Promise.resolve('')),
      ...(req.selection !== undefined ? { selection: req.selection } : {}),
    })
    if (!ra.ok)
      return post({
        ev: 'need-args',
        title: entry.title,
        specs: entry.meta.args,
        values: Object.fromEntries(
          Object.entries(req.args ?? {}).filter(
            ([k]) => entry.meta.args.find((s) => s.name === k)?.type !== 'secret',
          ),
        ),
        ...(ra.error ? { error: ra.error } : {}),
      })
    // Words typed beyond the declared args are passed through too.
    const argv = ra.argv

    if (this.active.size >= cfg.concurrency)
      return post({ ev: 'error', message: `too many scripts running (limit ${cfg.concurrency})` })

    // Terminal mode: hand over to the configured terminal; no streaming.
    if (entry.meta.output === 'terminal') {
      try {
        if (platform === 'darwin' && !cfg.terminal?.command) {
          if (argv.length)
            throw new Error(
              'terminal mode on macOS cannot pass arguments (use the command-line option in config/terminal.json)',
            )
          await spawnArgv({ file: 'open', args: ['-a', 'Terminal', entry.path] })
        } else
          await spawnArgv(
            terminalRun(platform, [interp.file, ...interp.args, entry.path, ...argv], cfg.terminal),
          )
        return post({ ev: 'toast', message: 'Opened in terminal' })
      } catch (e) {
        return post({
          ev: 'error',
          message: e instanceof Error ? e.message : 'could not open a terminal',
        })
      }
    }

    const plan = await this.plan(entry, interp, argv, platform, prep.content)
    if ('error' in plan) return post({ ev: 'error', message: plan.error })

    post({ ev: 'start', title: entry.title, mode: entry.meta.output })
    let stdout = ''
    const proc = runProcess({
      file: plan.file,
      args: plan.args,
      ...(plan.cwd ? { cwd: plan.cwd } : {}),
      env: buildEnv(
        [...cfg.envAllow, ...(entry.folder.env ?? [])],
        [...cfg.extraPath, ...(entry.folder.extraPath ?? [])],
        process.env,
        platform,
        { BEACON_SDK: '1' },
      ),
      timeoutMs: (entry.meta.timeoutSec ?? cfg.timeoutSec) * 1000,
      maxOutput: cfg.maxOutputBytes,
      ...(plan.stdin !== undefined ? { stdin: plan.stdin } : {}),
      platform,
      onOutput: (stream, text) => {
        if (stream === 'stdout') stdout += text
        if (entry.meta.output === 'inline') post({ ev: 'out', stream, text })
      },
      onControl: (m) => this.control(m, post),
    })
    this.active.set(runId, proc)
    this.d.onRunningChange?.(this.active.size)
    const res = await proc.promise
    this.active.delete(runId)
    this.d.onRunningChange?.(this.active.size)

    if (entry.meta.output === 'copy' && res.exitCode === 0) {
      await fx?.copy(stripAnsi(stdout).replace(/\n$/, ''))
      post({ ev: 'toast', message: 'Output copied' })
    } else if (
      (entry.meta.output === 'silent' || entry.meta.output === 'copy') &&
      res.exitCode !== 0
    ) {
      await fx?.notify(entry.title, `Exited with code ${res.exitCode ?? res.signal ?? 'error'}`)
    }
    post({ ev: 'exit', mode: entry.meta.output, ...res })
    await this.history(entry, res, entry.meta.saveOutput ? stripAnsi(stdout) : undefined)
  }

  private control(m: ControlMessage, post: (e: ScriptEvent) => void): void {
    const fx = this.d.effects()
    if (m.type === 'notify' && typeof m['title'] === 'string')
      void fx?.notify(
        m['title'].slice(0, 120),
        typeof m['body'] === 'string' ? m['body'].slice(0, 300) : undefined,
      )
    else if (m.type === 'progress')
      post({
        ev: 'progress',
        ...(typeof m['value'] === 'number' ? { value: Math.max(0, Math.min(1, m['value'])) } : {}),
        ...(typeof m['label'] === 'string' ? { label: m['label'].slice(0, 120) } : {}),
      })
  }

  /** What to spawn: local interpreter + script, or ssh with the script piped over stdin. */
  private async plan(
    entry: ScriptEntry,
    interp: Interpreter,
    argv: string[],
    platform: NodeJS.Platform,
    content: string,
  ): Promise<{ file: string; args: string[]; cwd?: string; stdin?: string } | { error: string }> {
    const cwd = entry.folder.cwd ?? dirname(entry.path)
    if (
      platform === 'win32' &&
      /\.(bat|cmd)$/i.test(entry.path) &&
      argv.some((a) => !SAFE_CMD_ARG.test(a))
    )
      return {
        error:
          'arguments contain characters cmd.exe would interpret (& | < > ^ % " ! ( )); not run',
      }
    if (entry.meta.ssh) {
      const alias = entry.meta.ssh
      const hosts = (await this.d.sshHosts?.()) ?? []
      if (!SAFE_HOST.test(alias) || !hosts.includes(alias))
        return { error: `"${alias}" is not a host in your ssh config` }
      const base = (interp.file.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '')
      const remote = /^(ba|z|da)?sh$/.test(base)
        ? [base, '-s', '--']
        : /^python3?$/.test(base)
          ? [base, '-', '--']
          : base === 'node'
            ? [base, '-', '--']
            : null
      if (!remote)
        return { error: `remote execution supports sh/bash/zsh, python and node (got ${base})` }
      // ssh joins the remote command into one string for the remote shell, so quote every word.
      return {
        file: 'ssh',
        args: [alias, ...remote.map(shQuote), ...argv.map(shQuote)],
        stdin: content,
        cwd,
      }
    }
    const stdin = undefined
    return {
      file: interp.file,
      args: [...interp.args, entry.path, ...argv],
      cwd,
      ...(stdin !== undefined ? { stdin } : {}),
    }
  }

  /** Non-interactive run (aliases, hotkeys, the CLI): requires the script to be trusted and needs no confirmation. */
  async runHeadless(
    scriptRef: string,
    args: string[] = [],
  ): Promise<{
    ok: boolean
    exitCode: number | null
    output: string
    truncated: boolean
    error?: string
  }> {
    const entries = this.d.entries()
    const entry = entries.find(
      (e) =>
        e.id === scriptRef ||
        e.path === scriptRef ||
        e.meta.keyword === scriptRef ||
        e.title.toLowerCase() === scriptRef.toLowerCase() ||
        basename(e.path) === scriptRef,
    )
    if (!entry)
      return {
        ok: false,
        exitCode: null,
        output: '',
        truncated: false,
        error: `no script matches "${scriptRef}"`,
      }
    const prep = await this.prepare(entry, { scriptId: entry.id })
    if ('error' in prep.interp)
      return { ok: false, exitCode: null, output: '', truncated: false, error: prep.interp.error }
    if (!this.d.trust.isTrusted(entry.path, prep.hash))
      return {
        ok: false,
        exitCode: null,
        output: '',
        truncated: false,
        error:
          'script is not trusted (or changed): run it once from the launcher to review and trust it',
      }
    if (entry.meta.confirm || entry.meta.ssh)
      return {
        ok: false,
        exitCode: null,
        output: '',
        truncated: false,
        error: 'this script requires confirmation; run it from the launcher',
      }
    if (entry.meta.args.some((a) => a.type === 'secret'))
      return {
        ok: false,
        exitCode: null,
        output: '',
        truncated: false,
        error: 'this script needs a secret argument; run it from the launcher',
      }
    const cfg = this.d.cfg()
    const platform = this.d.platform ?? process.platform
    // Positional args fill the declared args in order (defaults, choices and numbers are honoured);
    // anything beyond the declared args is passed through.
    const typeable = entry.meta.args.filter(
      (a) => !['clipboard', 'selection', 'secret'].includes(a.type),
    )
    const given: Record<string, string> = {}
    typeable.forEach((a, i) => {
      if (args[i] !== undefined) given[a.name] = args[i] as string
    })
    const fx = this.d.effects()
    const ra = await resolveArgs(entry.meta.args, {
      given,
      clipboard: () => (fx ? fx.readClipboard() : Promise.resolve('')),
    })
    if (!ra.ok)
      return {
        ok: false,
        exitCode: null,
        output: '',
        truncated: false,
        error: ra.error ?? `missing argument: ${ra.missing.map((m) => m.name).join(', ')}`,
      }
    const argv = [...ra.argv, ...args.slice(typeable.length)]
    const plan = await this.plan(entry, prep.interp, argv, platform, prep.content)
    if ('error' in plan)
      return { ok: false, exitCode: null, output: '', truncated: false, error: plan.error }
    let output = ''
    const res = await runProcess({
      file: plan.file,
      args: plan.args,
      ...(plan.cwd ? { cwd: plan.cwd } : {}),
      env: buildEnv(
        [...cfg.envAllow, ...(entry.folder.env ?? [])],
        [...cfg.extraPath, ...(entry.folder.extraPath ?? [])],
        process.env,
        platform,
        { BEACON_SDK: '1' },
      ),
      timeoutMs: (entry.meta.timeoutSec ?? cfg.timeoutSec) * 1000,
      maxOutput: cfg.maxOutputBytes,
      platform,
      onOutput: (_s, t) => (output += t),
    }).promise
    await this.history(entry, res, entry.meta.saveOutput ? stripAnsi(output) : undefined)
    return {
      ok: res.exitCode === 0,
      exitCode: res.exitCode,
      output: stripAnsi(output),
      truncated: res.truncated,
      ...(res.error ? { error: res.error } : {}),
    }
  }

  /** List mode: run a trusted script with the query and turn its JSON Lines into items. Cancellable. */
  async runList(
    entry: ScriptEntry,
    text: string,
    signal: AbortSignal,
  ): Promise<{ items: ListLine[]; error?: string; needsTrust?: boolean }> {
    const prep = await this.prepare(entry, { scriptId: entry.id })
    if ('error' in prep.interp) return { items: [], error: prep.interp.error }
    if (!this.d.trust.isTrusted(entry.path, prep.hash) || entry.meta.ssh || entry.meta.confirm)
      return { items: [], needsTrust: true }
    const cfg = this.d.cfg()
    const platform = this.d.platform ?? process.platform
    const plan = await this.plan(entry, prep.interp, [text], platform, prep.content)
    if ('error' in plan) return { items: [], error: plan.error }
    let out = ''
    const proc = runProcess({
      file: plan.file,
      args: plan.args,
      ...(plan.cwd ? { cwd: plan.cwd } : {}),
      stdin: text,
      env: buildEnv(
        [...cfg.envAllow, ...(entry.folder.env ?? [])],
        [...cfg.extraPath, ...(entry.folder.extraPath ?? [])],
        process.env,
        platform,
        { BEACON_SDK: '1', BEACON_QUERY: text },
      ),
      timeoutMs: Math.min((entry.meta.timeoutSec ?? 5) * 1000, 10_000),
      maxOutput: cfg.maxOutputBytes,
      platform,
      onOutput: (s, t) => {
        if (s === 'stdout') out += t
      },
    })
    const onAbort = () => proc.cancel()
    signal.addEventListener('abort', onAbort, { once: true })
    const res = await proc.promise
    signal.removeEventListener('abort', onAbort)
    return { items: parseJsonLines(stripAnsi(out)), ...(res.error ? { error: res.error } : {}) }
  }

  private async history(entry: ScriptEntry, res: RunResult, output?: string): Promise<void> {
    if (!this.d.cfg().history || !this.d.historyFile) return
    // Metadata only. Arguments are never recorded; output only when this script opted in.
    const line = JSON.stringify({
      ts: (this.d.now ?? Date.now)(),
      script: entry.path,
      exit: res.exitCode,
      ms: res.durationMs,
      ...(output !== undefined ? { output: output.slice(0, 20_000) } : {}),
    })
    await fs.mkdir(dirname(this.d.historyFile), { recursive: true })
    await fs.appendFile(this.d.historyFile, line + '\n')
  }
}
