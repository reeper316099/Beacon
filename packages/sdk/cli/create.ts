// npx tsx packages/sdk/cli/create.ts <folder> [Display Name]
import { basename } from 'node:path'
import { scaffold } from '../src/dev'

const [dir, ...nameParts] = process.argv.slice(2)
if (!dir) {
  console.error('usage: create.ts <folder> [Display Name]')
  process.exit(2)
}
const id = basename(dir)
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')
await scaffold(dir, id, nameParts.join(' ') || id)
console.log(`Created ${dir}. Try: npx tsx packages/sdk/cli/dev.ts ${dir} "hello"`)
