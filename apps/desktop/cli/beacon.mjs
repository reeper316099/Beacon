#!/usr/bin/env node
// Beacon CLI: drives the running app over its local API (127.0.0.1 + per-launch token).
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function dataDir() {
  if (process.env.BEACON_DATA_DIR) return process.env.BEACON_DATA_DIR
  if (process.platform === 'darwin') return join(homedir(), 'Library/Application Support/Beacon')
  if (process.platform === 'win32') return join(process.env.APPDATA ?? homedir(), 'Beacon')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Beacon')
}

const [cmd] = process.argv.slice(2)
const routes = {
  toggle: ['POST', 'toggle'],
  show: ['POST', 'show'],
  hide: ['POST', 'hide'],
  status: ['GET', 'status'],
}
if (!routes[cmd]) {
  console.error(
    cmd && ['query', 'run', 'reload'].includes(cmd)
      ? `beacon ${cmd}: not available yet (planned for M8).`
      : 'usage: beacon toggle|show|hide|status',
  )
  process.exit(2)
}
let api
try {
  api = JSON.parse(readFileSync(join(dataDir(), 'runtime/api.json'), 'utf8'))
} catch {
  console.error('Beacon is not running (no runtime/api.json).')
  process.exit(1)
}
const [method, path] = routes[cmd]
try {
  const res = await fetch(`http://127.0.0.1:${api.port}/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${api.token}` },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (cmd === 'status') console.log(JSON.stringify(await res.json(), null, 2))
} catch (e) {
  console.error(`beacon ${cmd} failed: ${e.message}`)
  process.exit(1)
}
