import { isAbsolute } from 'node:path'
import { z } from 'zod'

export type Permission =
  | { kind: 'clipboard.read' | 'clipboard.write' | 'notifications' | 'storage' }
  | { kind: 'fs.read' | 'fs.write'; scope: string }
  | { kind: 'exec'; bins: string[] }
  | { kind: 'network'; hosts: string[] }

const SIMPLE = ['clipboard.read', 'clipboard.write', 'notifications', 'storage'] as const
const BIN = /^[A-Za-z0-9._/\\:-]{1,200}$/
const HOST = /^(\*\.)?[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i

/** Parse a manifest permission string. Unknown or malformed permissions return null (and are rejected). */
export function parsePermission(s: string): Permission | null {
  if ((SIMPLE as readonly string[]).includes(s)) return { kind: s as (typeof SIMPLE)[number] }
  const i = s.indexOf(':')
  if (i < 0) return null
  const kind = s.slice(0, i)
  const arg = s.slice(i + 1)
  if (kind === 'fs.read' || kind === 'fs.write') {
    // A shape check that gives the same answer on every OS (comparing against normalize() would
    // not: it rewrites "/" to "\" on Windows). Real resolution happens per platform in the Grants.
    const segs = arg.replace(/[\\/]+$/, '').split(/[\\/]/)
    if (
      !isAbsolute(arg) ||
      segs.includes('..') ||
      segs.includes('.') ||
      /[^\\/][\\/]{2,}[^\\/]/.test(arg)
    )
      return null
    if (/^[\\/]+$/.test(arg) || /^[A-Za-z]:[\\/]?$/.test(arg)) return null // never the whole disk
    return { kind, scope: arg.replace(/[\\/]+$/, '') }
  }
  if (kind === 'exec') {
    const bins = arg
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean)
    return bins.length && bins.every((b) => BIN.test(b) && !b.includes('..'))
      ? { kind, bins }
      : null
  }
  if (kind === 'network') {
    const hosts = arg
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
    return hosts.length && hosts.every((h) => HOST.test(h)) ? { kind, hosts } : null
  }
  return null
}

export const describePermission = (p: Permission): string => {
  switch (p.kind) {
    case 'clipboard.read':
      return 'Read your clipboard'
    case 'clipboard.write':
      return 'Write to your clipboard'
    case 'notifications':
      return 'Show notifications'
    case 'storage':
      return 'Keep its own small private storage'
    case 'fs.read':
      return `Read files under ${p.scope}`
    case 'fs.write':
      return `Write files under ${p.scope}`
    case 'exec':
      return `Run these programs: ${p.bins.join(', ')}`
    case 'network':
      return `Connect to: ${p.hosts.join(', ')}`
  }
}

const ID = /^[a-z0-9][a-z0-9-]{1,39}$/

export const ManifestSchema = z
  .object({
    id: z.string().regex(ID, 'id must be 2-40 chars: a-z, 0-9, -'),
    name: z.string().min(1).max(60),
    version: z.string().regex(/^\d+\.\d+\.\d+([-+][\w.]+)?$/),
    apiVersion: z.literal(1),
    main: z.string().min(1).max(200),
    description: z.string().max(300).optional(),
    commands: z
      .array(
        z.object({
          keyword: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,19}$/i),
          title: z.string().min(1).max(80),
        }),
      )
      .max(20)
      .default([]),
    permissions: z.array(z.string().max(500)).max(20).default([]),
  })
  .strict()

export interface Manifest {
  id: string
  name: string
  version: string
  apiVersion: 1
  main: string
  description?: string
  commands: { keyword: string; title: string }[]
  permissions: Permission[]
  /** The permission strings exactly as written (shown to the user, hashed for re-consent). */
  permissionStrings: string[]
}

export const MAX_MANIFEST_BYTES = 64 * 1024

/** Validate manifest.json text. A malicious manifest (path traversal, unknown permissions, oversized) is rejected. */
export function parseManifest(
  text: string,
): { ok: true; manifest: Manifest } | { ok: false; error: string } {
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES)
    return { ok: false, error: 'manifest too large' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'manifest is not valid JSON' }
  }
  const r = ManifestSchema.safeParse(raw)
  if (!r.success)
    return {
      ok: false,
      error: r.error.issues[0]
        ? `${r.error.issues[0].path.join('.')}: ${r.error.issues[0].message}`
        : 'invalid manifest',
    }
  const m = r.data
  if (isAbsolute(m.main) || m.main.split(/[\\/]/).includes('..') || !/\.js$/.test(m.main))
    return { ok: false, error: 'main must be a relative .js file inside the extension folder' }
  const perms: Permission[] = []
  for (const s of m.permissions) {
    const p = parsePermission(s)
    if (!p) return { ok: false, error: `unknown or invalid permission: ${s.slice(0, 80)}` }
    perms.push(p)
  }
  return { ok: true, manifest: { ...m, permissions: perms, permissionStrings: m.permissions } }
}
