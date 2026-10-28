import { spawn } from 'node:child_process'
import type { LaunchSpec } from './types'

/** Launch detached; argv only, never a shell string. Resolves once spawned or rejects on spawn error. */
export function launch(spec: LaunchSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.file, spec.args, { detached: true, stdio: 'ignore', shell: false })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
