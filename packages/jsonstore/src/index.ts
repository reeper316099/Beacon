import { promises as fs } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import type { ZodType } from 'zod'

export interface JsonFileOptions<T> {
  path: string
  schema: ZodType<T, any, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Value used when the file is missing or unrecoverable. */
  defaults: () => T
  /** Migrate older on-disk data. `version` is the stored `schemaVersion` (0 if absent). */
  migrate?: (raw: unknown, version: number) => unknown
  /** Current schema version written to disk as `schemaVersion`. */
  version?: number
  /** How many rolling backups to keep. Default 5. */
  backups?: number
  onError?: (err: Error) => void
}

const queues = new Map<string, Promise<unknown>>()

/** Per-path mutex: operations on the same file run strictly one after another. */
function enqueue<R>(path: string, fn: () => Promise<R>): Promise<R> {
  const prev = queues.get(path) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(
    path,
    next.catch(() => {}),
  )
  return next
}

/** Atomic write: tmp → fsync → rename. */
export async function atomicWrite(path: string, data: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  const fh = await fs.open(tmp, 'w')
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  await fs.rename(tmp, path)
}

export class JsonFile<T> {
  private value: T
  constructor(private opts: JsonFileOptions<T>) {
    this.value = opts.defaults()
  }

  get path(): string {
    return this.opts.path
  }

  get data(): T {
    return this.value
  }

  private backupDir(): string {
    return join(dirname(this.opts.path), '.backups')
  }

  /** Load from disk. Corrupt/invalid files are quarantined and the latest good backup restored. */
  load(): Promise<T> {
    return enqueue(this.opts.path, async () => {
      const parsed = await this.tryRead(this.opts.path)
      if (parsed.ok) return (this.value = parsed.value)
      if (parsed.missing) return (this.value = this.opts.defaults())
      this.opts.onError?.(parsed.error)
      await fs
        .rename(this.opts.path, `${this.opts.path}.corrupt-${Date.now()}`)
        .catch(() => undefined)
      for (const b of await this.listBackups()) {
        const r = await this.tryRead(join(this.backupDir(), b))
        if (r.ok) {
          await atomicWrite(this.opts.path, JSON.stringify(this.serialize(r.value), null, 2))
          return (this.value = r.value)
        }
      }
      return (this.value = this.opts.defaults())
    })
  }

  private serialize(v: T): unknown {
    return this.opts.version !== undefined && v && typeof v === 'object'
      ? { ...v, schemaVersion: this.opts.version }
      : v
  }

  private async tryRead(
    path: string,
  ): Promise<{ ok: true; value: T } | { ok: false; missing: boolean; error: Error }> {
    let text: string
    try {
      text = await fs.readFile(path, 'utf8')
    } catch (e) {
      return {
        ok: false,
        missing: (e as NodeJS.ErrnoException).code === 'ENOENT',
        error: e as Error,
      }
    }
    try {
      let raw: unknown = JSON.parse(text)
      if (this.opts.migrate) {
        const v = (raw as { schemaVersion?: number } | null)?.schemaVersion ?? 0
        raw = this.opts.migrate(raw, v)
      }
      if (raw && typeof raw === 'object') delete (raw as Record<string, unknown>)['schemaVersion']
      return { ok: true, value: this.opts.schema.parse(raw) }
    } catch (e) {
      return { ok: false, missing: false, error: e as Error }
    }
  }

  private async listBackups(): Promise<string[]> {
    try {
      return (await fs.readdir(this.backupDir()))
        .filter((f) => f.startsWith(basename(this.opts.path) + '.'))
        .sort()
        .reverse()
    } catch {
      return []
    }
  }

  /** Validate and persist. Invalid values are rejected without touching memory or disk. */
  set(next: T): Promise<void> {
    const checked = this.opts.schema.parse(next)
    return enqueue(this.opts.path, async () => {
      const prev = await fs.readFile(this.opts.path, 'utf8').catch(() => undefined)
      await atomicWrite(this.opts.path, JSON.stringify(this.serialize(checked), null, 2))
      this.value = checked
      if (prev !== undefined) await this.rotate(prev)
    })
  }

  update(fn: (draft: T) => T): Promise<void> {
    return this.set(fn(structuredClone(this.value)))
  }

  private async rotate(prev: string): Promise<void> {
    const keep = this.opts.backups ?? 5
    const name = `${basename(this.opts.path)}.${Date.now().toString().padStart(15, '0')}`
    await fs.mkdir(this.backupDir(), { recursive: true })
    await fs.writeFile(join(this.backupDir(), name), prev)
    for (const old of (await this.listBackups()).slice(keep))
      await fs.unlink(join(this.backupDir(), old)).catch(() => undefined)
  }
}
