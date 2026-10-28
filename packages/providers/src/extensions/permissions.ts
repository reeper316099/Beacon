import { basename, dirname, resolve, sep } from 'node:path'
import type { Permission } from './manifest'

export type Op =
  | { op: 'clipboard.read' | 'clipboard.write' | 'notify' | 'storage' }
  | { op: 'fs.read' | 'fs.write'; path: string }
  | { op: 'exec'; file: string }
  | { op: 'fetch'; url: string }

const inScope = (scope: string, target: string): boolean =>
  target === scope || target.startsWith(scope + sep)

/** Default-deny capability check. `realpath` must resolve symlinks of the target (or its nearest existing parent). */
export class Grants {
  constructor(
    private perms: Permission[],
    private realpath: (p: string) => Promise<string> = async (p) => p,
  ) {}

  /** realpath() that also works for files that don't exist yet: resolve the nearest existing parent. */
  private async resolveReal(p: string): Promise<string> {
    let cur = resolve(p) // also collapses ".." before any symlink resolution
    const tail: string[] = []
    for (let i = 0; i < 64; i++) {
      try {
        const real = await this.realpath(cur)
        return tail.length ? resolve(real, ...tail.reverse()) : real
      } catch {
        const up = dirname(cur)
        if (up === cur) break
        tail.push(basename(cur))
        cur = up
      }
    }
    throw new Error('unresolvable')
  }

  /** Returns null when allowed, otherwise a short reason. */
  async check(o: Op): Promise<string | null> {
    switch (o.op) {
      case 'clipboard.read':
      case 'clipboard.write':
        return this.perms.some((p) => p.kind === o.op) ? null : `needs the ${o.op} permission`
      case 'notify':
        return this.perms.some((p) => p.kind === 'notifications')
          ? null
          : 'needs the notifications permission'
      case 'storage':
        return this.perms.some((p) => p.kind === 'storage') ? null : 'needs the storage permission'
      case 'fs.read':
      case 'fs.write': {
        const scopes = this.perms
          .filter((p): p is Extract<Permission, { scope: string }> => p.kind === o.op)
          .map((p) => p.scope)
        if (!scopes.length) return `needs the ${o.op} permission`
        let target: string
        try {
          target = await this.resolveReal(o.path)
        } catch {
          return 'path could not be resolved'
        }
        // The real path (after symlinks) must be inside a granted scope that is itself resolved.
        for (const s of scopes) {
          let rs = s
          try {
            rs = await this.resolveReal(s)
          } catch {
            /* scope may not exist yet */
          }
          if (inScope(rs, target)) return null
        }
        return `path is outside the granted ${o.op} scope`
      }
      case 'exec': {
        const bins = this.perms
          .filter((p): p is Extract<Permission, { kind: 'exec' }> => p.kind === 'exec')
          .flatMap((p) => p.bins)
        return bins.includes(o.file)
          ? null
          : bins.length
            ? `"${o.file}" is not an allowed program`
            : 'needs the exec permission'
      }
      case 'fetch': {
        let u: URL
        try {
          u = new URL(o.url)
        } catch {
          return 'invalid URL'
        }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'only http(s) is allowed'
        const hosts = this.perms
          .filter((p): p is Extract<Permission, { kind: 'network' }> => p.kind === 'network')
          .flatMap((p) => p.hosts)
        if (!hosts.length) return 'needs the network permission (network is off by default)'
        const h = u.hostname.toLowerCase()
        return hosts.some((x) =>
          x.startsWith('*.') ? h.endsWith(x.slice(1)) && h.length > x.length - 1 : h === x,
        )
          ? null
          : `host "${h}" is not allowed`
      }
    }
  }
}
