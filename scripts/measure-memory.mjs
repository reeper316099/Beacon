// Idle memory of the Beacon process tree, as private/physical footprint (not summed working set,
// which double-counts pages shared between Electron processes).
//   macOS: `footprint`   Linux: smaps_rollup Pss   Windows: PrivateMemorySize64
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const settleMs = Number(process.env.SETTLE_MS ?? 10000)
const electron = join(import.meta.dirname, '../node_modules/.bin/electron')
const env = { ...process.env, BEACON_DATA_DIR: mkdtempSync(join(tmpdir(), 'beacon-mem-')) }
const child = spawn(electron, ['apps/desktop'], {
  env,
  stdio: 'ignore',
  cwd: join(import.meta.dirname, '..'),
})
await new Promise((r) => setTimeout(r, settleMs))

function tree(root) {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId | ConvertTo-Json`,
      ],
      { encoding: 'utf8' },
    )
    var rows = JSON.parse(out).map((p) => [p.ProcessId, p.ParentProcessId])
  } else {
    rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number))
  }
  const pids = new Set([root])
  for (let grew = true; grew;) {
    grew = false
    for (const [pid, ppid] of rows)
      if (pids.has(ppid) && !pids.has(pid)) {
        pids.add(pid)
        grew = true
      }
  }
  return [...pids]
}

let totalMB = 0
for (const pid of tree(child.pid)) {
  try {
    if (process.platform === 'darwin') {
      const o = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8' })
      const m = /Footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(o)
      if (m) totalMB += Number(m[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[m[2]]
    } else if (process.platform === 'linux') {
      const m = /Pss:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))
      if (m) totalMB += Number(m[1]) / 1024
    } else {
      const o = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).PrivateMemorySize64`],
        { encoding: 'utf8' },
      )
      totalMB += Number(o) / 1048576
    }
  } catch {
    /* process exited */
  }
}
console.log(`idle private memory: ${totalMB.toFixed(0)} MB (${process.platform}, target < ~200 MB)`)
child.kill()
setTimeout(() => process.exit(0), 500)
