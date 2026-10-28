// Public-repo guard: fail if tracked files contain personal paths, secrets or private fixtures.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)

const patterns = [
  [/\/Users\/(?!example|you|user|runner)[A-Za-z0-9._-]+\//, 'personal macOS home path'],
  [/C:\\Users\\(?!example|you|user|runner)[A-Za-z0-9._-]+\\/, 'personal Windows home path'],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bghp_[A-Za-z0-9]{36}\b/, 'GitHub token'],
]

let failed = false
for (const f of files) {
  if (f.startsWith('private-fixtures/') && f !== 'private-fixtures/.gitkeep') {
    console.error(`guard: private fixture tracked: ${f}`)
    failed = true
    continue
  }
  if (f === 'scripts/guard.mjs' || f === 'package-lock.json') continue
  let text
  try {
    text = readFileSync(f, 'utf8')
  } catch {
    continue
  }
  if (text.includes('\0')) continue
  for (const [re, label] of patterns) {
    if (re.test(text)) {
      console.error(`guard: ${label} in ${f}`)
      failed = true
    }
  }
}
if (failed) process.exit(1)
console.log(`guard: ok (${files.length} files)`)
