import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { FuzzyIndex } from '@beacon/matcher'
import type { Action, ParsedQuery, ProviderContext, ResultItem } from '@beacon/shared'
import { LiveProvider, item, spawnArgv, copyAction } from './base'
import { SAFE_HOST, terminalRun, type TerminalConfig } from './terminal'

export interface SshHost {
  alias: string
  hostName?: string
  user?: string
  port?: string
  identityFile?: string
}

/** Minimal glob for Include lines: supports * and ? within a single path segment. */
async function expandInclude(pattern: string, baseDir: string): Promise<string[]> {
  const p = pattern.startsWith('~')
    ? join(homedir(), pattern.slice(1))
    : isAbsolute(pattern)
      ? pattern
      : resolve(baseDir, pattern)
  if (!/[*?]/.test(p)) return [p]
  const dir = dirname(p)
  const re = new RegExp(
    '^' +
      p
        .slice(dir.length + 1)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  )
  try {
    return (await fs.readdir(dir))
      .filter((f) => re.test(f))
      .sort()
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

/**
 * Parse an ssh_config text (and its Includes). Wildcard/negated Host patterns are ignored.
 * Private keys are never read; `IdentityFile` is only displayed as a path.
 */
export async function parseSshConfig(
  file: string,
  depth = 0,
  seen = new Set<string>(),
): Promise<SshHost[]> {
  if (depth > 5 || seen.has(file)) return []
  seen.add(file)
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return []
  }
  const hosts: SshHost[] = []
  let cur: SshHost[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(line)
    if (!m) continue
    const key = (m[1] as string).toLowerCase()
    const val = (m[2] as string)
      .replace(/\s+#.*$/, '')
      .replace(/^"(.*)"$/, '$1')
      .trim()
    if (key === 'include') {
      for (const pat of val.split(/\s+/))
        for (const f of await expandInclude(pat, join(homedir(), '.ssh')))
          hosts.push(...(await parseSshConfig(f, depth + 1, seen)))
    } else if (key === 'host') {
      cur = val
        .split(/\s+/)
        .filter((h) => !/[*?!]/.test(h) && SAFE_HOST.test(h))
        .map((alias) => ({ alias }))
      hosts.push(...cur)
    } else if (key === 'match') cur = []
    else
      for (const h of cur) {
        if (key === 'hostname') h.hostName ??= val
        else if (key === 'user') h.user ??= val
        else if (key === 'port') h.port ??= val
        else if (key === 'identityfile') h.identityFile ??= val
      }
  }
  return hosts
}

/** Host names from known_hosts (plain entries only; hashed ones are skipped). Optional. */
export async function parseKnownHosts(file: string): Promise<string[]> {
  let text = ''
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return []
  }
  const out = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const first = line.split(/\s+/)[0]
    if (!first || first.startsWith('#') || first.startsWith('|') || first.startsWith('@')) continue
    for (const h of first.split(',')) {
      const name = h.replace(/^\[(.+)\]:\d+$/, '$1')
      if (SAFE_HOST.test(name)) out.add(name)
    }
  }
  return [...out]
}

export class SshProvider extends LiveProvider {
  id = 'ssh'
  name = 'SSH hosts'
  mode = 'prefix-only' as const
  triggers = ['ssh ', 'ssh']
  private hosts: SshHost[] = []
  constructor(
    private configPath = join(homedir(), '.ssh/config'),
    private platform: NodeJS.Platform = process.platform,
    private terminal: () => TerminalConfig = () => ({}),
    private includeKnownHosts = false,
  ) {
    super()
  }

  async refresh(): Promise<void> {
    const hosts = await parseSshConfig(this.configPath)
    if (this.includeKnownHosts) {
      const have = new Set(hosts.map((h) => h.alias))
      for (const n of await parseKnownHosts(join(dirname(this.configPath), 'known_hosts')))
        if (!have.has(n)) hosts.push({ alias: n })
    }
    this.hosts = hosts
  }

  protected async compute(q: ParsedQuery): Promise<ResultItem[]> {
    if (!this.hosts.length) await this.refresh()
    const found = q.text
      ? new FuzzyIndex(
          this.hosts.map((h) => [[h.alias, h.hostName ?? '', h.user ?? ''].join(' '), h] as const),
        )
          .search(q.text, 30)
          .map((r) => r.item)
      : this.hosts.slice(0, 30)
    return found.map((h, i) => {
      const target = `${h.user ? h.user + '@' : ''}${h.hostName ?? h.alias}${h.port ? ':' + h.port : ''}`
      return item(this.id, {
        id: 'ssh:' + h.alias,
        title: h.alias,
        subtitle: target,
        kind: 'ssh',
        score: 500 - i,
        primary: {
          id: 'connect',
          title: `ssh ${h.alias}`,
          kind: 'custom',
          payload: { alias: h.alias },
        },
        actions: [copyAction(`ssh ${h.alias}`, 'Copy ssh command')],
      })
    })
  }

  protected async custom(a: Action, _it: ResultItem, _ctx: ProviderContext): Promise<void> {
    const alias = (a.payload as { alias?: string }).alias
    if (a.id !== 'connect' || !alias || !this.hosts.some((h) => h.alias === alias))
      throw new Error('unknown host')
    // argv, never a shell string; alias comes from the user's own config and is validated.
    await spawnArgv(terminalRun(this.platform, ['ssh', alias], this.terminal()))
  }
}
