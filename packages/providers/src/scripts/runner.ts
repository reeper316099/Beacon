import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { AnsiSanitizer } from './ansi'

export interface ControlMessage {
  type: string
  [k: string]: unknown
}

export interface RunOptions {
  file: string
  args: string[]
  cwd?: string
  env: Record<string, string>
  timeoutMs: number
  maxOutput: number
  graceMs?: number
  stdin?: string
  onOutput(stream: 'stdout' | 'stderr', text: string): void
  /** Lines starting with "@@beacon " (the SDK protocol) are parsed and not shown as output. */
  onControl?(m: ControlMessage): void
  platform?: NodeJS.Platform
}

export interface RunResult {
  exitCode: number | null
  signal: string | null
  durationMs: number
  truncated: boolean
  timedOut: boolean
  cancelled: boolean
  error?: string
}

export const SDK_PREFIX = '@@beacon '

class Stream {
  private dec = new StringDecoder('utf8')
  private san = new AnsiSanitizer()
  private buf = ''
  constructor(
    private isOut: boolean,
    private emit: (s: string) => void,
    private control: ((m: ControlMessage) => void) | undefined,
  ) {}

  write(b: Buffer): void {
    this.buf += this.dec.write(b)
    this.drain(false)
  }

  end(): void {
    this.buf += this.dec.end()
    this.drain(true)
    const rest = this.san.flush()
    if (rest) this.emit(rest)
  }

  private drain(final: boolean): void {
    for (;;) {
      const nl = this.buf.indexOf('\n')
      if (nl < 0) break
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (!this.handleControl(line)) this.out(line + '\n')
    }
    if (!this.buf) return
    // Keep a partial line only while it could still turn out to be an SDK control line.
    const couldBeControl =
      this.isOut && (SDK_PREFIX.startsWith(this.buf) || this.buf.startsWith(SDK_PREFIX))
    if (final || !couldBeControl) {
      const line = this.buf
      this.buf = ''
      if (!(final && this.handleControl(line))) this.out(line)
    }
  }

  private handleControl(line: string): boolean {
    if (!this.isOut || !line.startsWith(SDK_PREFIX)) return false
    try {
      const m = JSON.parse(line.slice(SDK_PREFIX.length)) as ControlMessage
      if (m && typeof m === 'object' && typeof m.type === 'string') this.control?.(m)
    } catch {
      /* malformed control line: dropped */
    }
    return true
  }

  private out(s: string): void {
    const c = this.san.push(s)
    if (c) this.emit(c)
  }
}

export function killTree(
  child: ChildProcess,
  signal: 'SIGTERM' | 'SIGKILL',
  platform = process.platform,
): void {
  const pid = child.pid
  if (!pid) return
  if (platform === 'win32') {
    // taskkill /T kills the whole tree; argv, no shell.
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on(
      'error',
      () => child.kill(),
    )
    return
  }
  try {
    process.kill(-pid, signal) // the child leads its own process group
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

/** Run a program with argv only (never a shell string). Streams sanitized output; enforces timeout and a size cap. */
export function runProcess(o: RunOptions): { promise: Promise<RunResult>; cancel(): void } {
  const platform = o.platform ?? process.platform
  const started = Date.now()
  let timedOut = false
  let cancelled = false
  let truncated = false
  let sent = 0
  let child: ChildProcess | undefined
  let killTimer: NodeJS.Timeout | undefined

  const cancel = (): void => {
    if (!child || cancelled) return
    cancelled = true
    killTree(child, 'SIGTERM', platform)
    killTimer = setTimeout(() => child && killTree(child, 'SIGKILL', platform), o.graceMs ?? 3000)
  }

  const promise = new Promise<RunResult>((resolve) => {
    const finish = (r: Partial<RunResult>): void => {
      clearTimeout(killTimer)
      clearTimeout(timer)
      resolve({
        exitCode: null,
        signal: null,
        durationMs: Date.now() - started,
        truncated,
        timedOut,
        cancelled,
        ...r,
      })
    }
    const emit =
      (stream: 'stdout' | 'stderr') =>
      (s: string): void => {
        if (truncated) return
        if (sent + s.length > o.maxOutput) {
          s = s.slice(0, Math.max(0, o.maxOutput - sent))
          truncated = true
        }
        sent += s.length
        if (s) o.onOutput(stream, s)
      }
    const out = new Stream(true, emit('stdout'), o.onControl)
    const err = new Stream(false, emit('stderr'), undefined)
    try {
      child = spawn(o.file, o.args, {
        cwd: o.cwd,
        env: o.env,
        shell: false,
        detached: platform !== 'win32',
        windowsHide: true,
        stdio: [o.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      return finish({ error: e instanceof Error ? e.message : String(e) })
    }
    child.stdout?.on('data', (b: Buffer) => out.write(b))
    child.stderr?.on('data', (b: Buffer) => err.write(b))
    if (o.stdin !== undefined) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(o.stdin)
    }
    const timer = setTimeout(() => {
      timedOut = true
      cancel()
    }, o.timeoutMs)
    child.once('error', (e) => finish({ error: e.message }))
    child.once('close', (code, signal) => {
      out.end()
      err.end()
      if (truncated) o.onOutput('stderr', '\n[output truncated]\n')
      finish({ exitCode: code, signal })
    })
  })
  return { promise, cancel }
}
