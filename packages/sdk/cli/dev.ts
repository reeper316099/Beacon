// npx tsx packages/sdk/cli/dev.ts <extension-folder> "<query>"
import { runDev } from '../src/dev'

const [dir, ...q] = process.argv.slice(2)
if (!dir) {
  console.error('usage: dev.ts <extension-folder> "<query>"')
  process.exit(2)
}
await runDev(dir, q.join(' '))
