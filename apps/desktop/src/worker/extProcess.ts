// Extension process (Electron utilityProcess, one per enabled extension).
// Extension code runs inside a QuickJS sandbox here; the only way out is host-checked `ctx.*` calls.
import { serveExtension } from '@beacon/providers/extensions/sandbox'

const parentPort = (process as unknown as { parentPort: Electron.ParentPort }).parentPort

serveExtension({
  send: (m) => parentPort.postMessage(m),
  onMessage: (cb) => parentPort.on('message', (e) => cb(e.data)),
})
