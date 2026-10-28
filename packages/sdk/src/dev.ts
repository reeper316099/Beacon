import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { Grants, parseManifest, sanitizeItems, type Manifest } from '@beacon/providers/extensions'
import { createSandbox } from '@beacon/providers/extensions/sandbox'

/** Files that `create` writes into a new extension folder. */
export async function scaffold(dir: string, id: string, name: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)) throw new Error('id must be 2-40 chars: a-z, 0-9, -')
  const tplDir = new URL('../template/', import.meta.url)
  await fs.mkdir(dir, { recursive: false })
  const manifest = JSON.parse(
    await fs.readFile(new URL('manifest.json', tplDir), 'utf8'),
  ) as Record<string, unknown>
  await fs.writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(
      { ...manifest, id, name, commands: [{ keyword: id.split('-')[0], title: name }] },
      null,
      2,
    ) + '\n',
  )
  await fs.copyFile(new URL('index.js', tplDir), join(dir, 'index.js'))
  await fs.writeFile(
    join(dir, 'README.md'),
    `# ${name}\n\nA Beacon extension. Test it with:\n\n    npx tsx packages/sdk/cli/dev.ts ${dir} "<query>"\n\nInstall by copying this folder into Beacon's extensions folder, then type \`ext\` in the launcher to enable it.\nThe extension is not signed; only share it with people who trust you.\n`,
  )
}

/**
 * Local dev runner: loads the extension in the same sandbox the app uses and runs `query`.
 * Capability calls are checked against the manifest's permissions and answered with harmless fakes
 * (and printed), so you can see exactly what your extension asks for.
 */
export async function runDev(
  dir: string,
  text: string,
  log: (s: string) => void = console.log,
): Promise<ReturnType<typeof sanitizeItems>> {
  const m = parseManifest(await fs.readFile(join(dir, 'manifest.json'), 'utf8'))
  if (!m.ok) throw new Error(`manifest: ${m.error}`)
  const manifest: Manifest = m.manifest
  const code = await fs.readFile(join(dir, manifest.main), 'utf8')
  const grants = new Grants(manifest.permissions, (p) => fs.realpath(p))
  const fake: Record<string, unknown> = {
    'clipboard.read': 'FAKE CLIPBOARD',
    'storage.get': null,
    'fs.read': 'FAKE FILE',
    exec: { code: 0, stdout: 'fake', stderr: '' },
    fetch: { status: 200, body: 'fake' },
  }
  const sandbox = await createSandbox({
    code,
    onCall: async (op, argsJson) => {
      const args = JSON.parse(argsJson) as unknown[]
      const opName = op === 'notify' ? 'notify' : op.startsWith('storage') ? 'storage' : op
      const denied = await grants.check({
        op: opName,
        path: String(args[0] ?? ''),
        file: String(args[0] ?? ''),
        url: String(args[0] ?? ''),
      } as never)
      log(
        `  ctx.${op}(${argsJson.slice(0, 80)}) → ${denied ? 'DENIED: ' + denied : 'allowed (fake result)'}`,
      )
      return JSON.stringify(
        denied
          ? { ok: false, error: `permission denied: ${denied}` }
          : { ok: true, value: fake[op] ?? null },
      )
    },
  })
  try {
    const terms = text.split(/\s+/).filter(Boolean)
    const items = sanitizeItems(manifest.id, await sandbox.invoke('query', [{ text, terms }]))
    log(`${items.length} item(s)`)
    for (const i of items)
      log(`  • ${i.title}${i.subtitle ? ' — ' + i.subtitle : ''}  [${i.primary.kind}]`)
    return items
  } finally {
    sandbox.dispose()
  }
}
