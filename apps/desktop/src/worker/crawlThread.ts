// Short-lived crawl process. The crawl allocates a lot of garbage; doing it in a child process that
// exits afterwards returns all of it to the OS, so the long-lived search worker only holds the result.
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { crawl, makeIgnore } from '@beacon/providers/files'

interface Job {
  roots: string[]
  ignoreNames: string[]
  ignoreGlobs: string[]
  maxFiles: number
  gitignore: boolean
  out: string
}

async function run(): Promise<void> {
  const job = JSON.parse(process.argv[2] as string) as Job
  const entries = await crawl({
    roots: job.roots,
    ignore: makeIgnore(job.ignoreNames, job.ignoreGlobs),
    maxFiles: job.maxFiles,
    gitignore: job.gitignore,
    onProgress: (n) => process.send?.({ type: 'progress', n }),
  })
  await fs.mkdir(dirname(job.out), { recursive: true })
  const tmp = job.out + '.tmp'
  await fs.writeFile(tmp, entries.map((e) => (e.isDir ? 'd' : 'f') + e.path).join('\n'))
  await fs.rename(tmp, job.out)
  process.send?.({ type: 'done', count: entries.length }, () => process.exit(0))
}

void run()
