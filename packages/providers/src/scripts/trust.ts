import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { JsonFile } from '@beacon/jsonstore'

export type TrustFile = Record<string, { hash: string; at: number }>

export const hashContent = (text: Buffer | string): string =>
  createHash('sha256').update(text).digest('hex')

/** Line diff (LCS) for the "what changed" preview. Small inputs only. */
export function diffLines(oldText: string, newText: string, maxLines = 400): string {
  const a = oldText.split('\n').slice(0, maxLines)
  const b = newText.split('\n').slice(0, maxLines)
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i]![j] =
        a[i] === b[j]
          ? (dp[i + 1]![j + 1] as number) + 1
          : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number)
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
    } else if ((dp[i + 1]![j] as number) >= (dp[i]![j + 1] as number)) out.push('- ' + a[i++])
    else out.push('+ ' + b[j++])
  }
  while (i < a.length) out.push('- ' + a[i++])
  while (j < b.length) out.push('+ ' + b[j++])
  return out.join('\n')
}

/**
 * Trust-on-first-use per script: the content hash is what is trusted, so any edit re-confirms.
 * The trusted text is snapshotted so a later change can show a diff.
 */
export class ScriptTrust {
  constructor(
    private file: JsonFile<TrustFile>,
    private snapshotDir: string,
  ) {}

  isTrusted(path: string, hash: string): boolean {
    return this.file.data[path]?.hash === hash
  }

  hasHistory(path: string): boolean {
    return !!this.file.data[path]
  }

  async trust(path: string, hash: string, content: string): Promise<void> {
    await fs.mkdir(this.snapshotDir, { recursive: true })
    await fs.writeFile(join(this.snapshotDir, hash + '.txt'), content.slice(0, 64_000))
    await this.file.update((d) => ({ ...d, [path]: { hash, at: Date.now() } }))
  }

  /** Diff against the last trusted version, or the first lines when never trusted. */
  async review(path: string, content: string): Promise<{ kind: 'new' | 'changed'; text: string }> {
    const prev = this.file.data[path]
    if (prev) {
      const old = await fs
        .readFile(join(this.snapshotDir, prev.hash + '.txt'), 'utf8')
        .catch(() => undefined)
      if (old !== undefined)
        return { kind: 'changed', text: diffLines(old, content) || '(no textual difference)' }
      return {
        kind: 'changed',
        text: '(previous version unavailable)\n' + content.split('\n').slice(0, 40).join('\n'),
      }
    }
    return { kind: 'new', text: content.split('\n').slice(0, 40).join('\n') }
  }
}
