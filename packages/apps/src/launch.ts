import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import type { LaunchSpec } from './types'

/** Launch detached; argv only, never a shell string. Resolves once spawned or rejects on spawn error. */
export function launch(spec: LaunchSpec): Promise<void> {
  // End-to-end tests record launches instead of starting programs.
  const log = process.env['BEACON_E2E_LOG']
  if (log) {
    appendFileSync(log, JSON.stringify({ kind: 'launch', file: spec.file, args: spec.args }) + '\n')
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const child = spawn(spec.file, spec.args, { detached: true, stdio: 'ignore', shell: false })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
