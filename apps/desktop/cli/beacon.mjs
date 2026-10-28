#!/usr/bin/env node
// Beacon CLI: drives the running app over its local API (127.0.0.1 + per-launch token).
//   beacon toggle|show|hide|status|reload
//   beacon query <text...> [--json]
//   beacon run <script> [-- args...]
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function dataDir() {
  if (process.env.BEACON_DATA_DIR) return process.env.BEACON_DATA_DIR
  if (process.platform === 'darwin') return join(homedir(), 'Library/Application Support/Beacon')
  if (process.platform === 'win32') return join(process.env.APPDATA ?? homedir(), 'Beacon')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Beacon')
}

const argv = process.argv.slice(2)
const [cmd, ...rest] = argv
const simple = {
  toggle: ['POST', 'toggle'],
  show: ['POST', 'show'],
  hide: ['POST', 'hide'],
  reload: ['POST', 'reload'],
  status: ['GET', 'status'],
}
const usage = () => {
  console.error(
    'usage: beacon toggle|show|hide|status|reload\n       beacon query <text...> [--json]\n       beacon run <script> [-- args...]',
  )
  process.exit(2)
}
if (!cmd || !(simple[cmd] || cmd === 'query' || cmd === 'run')) usage()

let api
try {
  api = JSON.parse(readFileSync(join(dataDir(), 'runtime/api.json'), 'utf8'))
} catch {
  console.error('Beacon is not running (no runtime/api.json).')
  process.exit(1)
}

async function call(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${api.port}/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${api.token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

try {
  if (simple[cmd]) {
    const [method, path] = simple[cmd]
    const out = await call(method, path)
    if (cmd === 'status') console.log(JSON.stringify(out, null, 2))
  } else if (cmd === 'query') {
    const json = rest.includes('--json')
    const text = rest.filter((a) => a !== '--json').join(' ')
    const { items } = await call('POST', 'query', { text })
    if (json) console.log(JSON.stringify(items, null, 2))
    else
      for (const i of items)
        console.log(`${i.title}${i.subtitle ? '  —  ' + i.subtitle : ''}  [${i.provider}]`)
  } else if (cmd === 'run') {
    const dd = rest.indexOf('--')
    const script = rest[0]
    if (!script || script === '--') usage()
    const args = dd >= 0 ? rest.slice(dd + 1) : rest.slice(1)
    const r = await call('POST', 'run', { script, args })
    if (r.output) process.stdout.write(r.output.endsWith('\n') ? r.output : r.output + '\n')
    if (r.error) console.error(r.error)
    process.exit(r.ok ? 0 : typeof r.exitCode === 'number' && r.exitCode > 0 ? r.exitCode : 1)
  }
} catch (e) {
  console.error(`beacon ${cmd} failed: ${e.message}`)
  process.exit(1)
}
