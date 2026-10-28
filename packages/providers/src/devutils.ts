import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'

export interface DevOut {
  title: string
  subtitle?: string
  /** Text copied by the primary action. */
  copy: string
}

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function ulid(now = Date.now(), rand: Uint8Array = randomBytes(10)): string {
  let t = now
  let time = ''
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time
    t = Math.floor(t / 32)
  }
  let bits = 0n
  for (const b of rand) bits = (bits << 8n) | BigInt(b)
  let r = ''
  for (let i = 0; i < 16; i++) {
    r = B32[Number(bits & 31n)] + r
    bits >>= 5n
  }
  return time + r
}

export const hash = (algo: string, text: string): string =>
  createHash(algo).update(text).digest('hex')

export const b64enc = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
export function b64dec(s: string): string {
  const t = s.trim().replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t)) throw new Error('not valid base64')
  return Buffer.from(t, 'base64').toString('utf8')
}

export function jwtDecode(token: string): { header: unknown; payload: unknown } {
  const parts = token.trim().split('.')
  if (parts.length < 2) throw new Error('not a JWT')
  return {
    header: JSON.parse(b64dec(parts[0] as string)),
    payload: JSON.parse(b64dec(parts[1] as string)),
  }
}

export function timestamp(
  arg: string,
  now = new Date(),
): { iso: string; epoch: number; ms: number } {
  const a = arg.trim()
  let d: Date
  if (!a || a === 'now') d = now
  else if (/^-?\d+(\.\d+)?$/.test(a)) {
    const n = Number(a)
    d = new Date(Math.abs(n) >= 1e11 ? n : n * 1000)
  } else d = new Date(a)
  if (Number.isNaN(d.getTime())) throw new Error('unrecognized date')
  return { iso: d.toISOString(), epoch: Math.floor(d.getTime() / 1000), ms: d.getTime() }
}

const WORDS =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur'.split(
    ' ',
  )
export function lorem(words: number): string {
  const n = Math.max(1, Math.min(words, 500))
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(WORDS[i % WORDS.length] as string)
  const s = out.join(' ')
  return s[0]!.toUpperCase() + s.slice(1) + '.'
}

const PW = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+'
export function password(len: number): string {
  const n = Math.max(8, Math.min(len, 128))
  let s = ''
  for (let i = 0; i < n; i++) s += PW[randomInt(PW.length)]
  return s
}

/** Run a regex with a hard time limit (vm timeout interrupts catastrophic backtracking). */
export function regexTest(pattern: string, flags: string, text: string): string[] {
  if (text.length > 20_000 || pattern.length > 500) throw new Error('input too large')
  if (!/^[dgimsuvy]*$/.test(flags)) throw new Error('bad flags')
  const out = runInNewContext(
    `(() => { const re = new RegExp(p, f.includes('g') ? f : f + 'g'); const r = []; let m;
      while ((m = re.exec(t)) && r.length < 50) { r.push(m[0]); if (m[0] === '') re.lastIndex++ } return r })()`,
    { p: pattern, f: flags, t: text },
    { timeout: 100 },
  ) as string[]
  return [...out]
}

type Cmd = (
  args: string[],
  raw: string,
  readClip: () => Promise<string>,
) => Promise<DevOut[]> | DevOut[]

const cut = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const one = (title: string, copy: string, subtitle?: string): DevOut[] => [
  { title, copy, ...(subtitle ? { subtitle } : {}) },
]

export const DEV_COMMANDS: Record<string, { usage: string; run: Cmd }> = {
  uuid: { usage: 'uuid', run: () => one(randomUUID(), randomUUID(), 'UUID v4') },
  ulid: {
    usage: 'ulid',
    run: () => {
      const u = ulid()
      return one(u, u, 'ULID')
    },
  },
  pw: {
    usage: 'pw [length]',
    run: ([n]) => {
      const p = password(Number(n) || 20)
      return one(p, p, 'Random password (CSPRNG)')
    },
  },
  lorem: {
    usage: 'lorem [words]',
    run: ([n]) => {
      const t = lorem(Number(n) || 30)
      return one(cut(t), t, 'Lorem ipsum')
    },
  },
  hash: {
    usage: 'hash [sha256|sha1|sha512|md5] <text|clipboard>',
    async run(args, _raw, clip) {
      let algo = 'sha256'
      if (args[0] && ['sha256', 'sha1', 'sha512', 'md5'].includes(args[0].toLowerCase()))
        algo = (args.shift() as string).toLowerCase()
      let text = args.join(' ')
      if (text === 'clipboard') text = await clip()
      if (!text) return []
      const h = hash(algo, text)
      return one(h, h, algo.toUpperCase())
    },
  },
  b64: {
    usage: 'b64 enc|dec <text>',
    run([mode, ...rest]) {
      const text = rest.join(' ')
      if (!text || !mode) return []
      if (mode.startsWith('d')) {
        const r = b64dec(text)
        return one(cut(r), r, 'Base64 decoded')
      }
      const r = b64enc(text)
      return one(cut(r), r, 'Base64 encoded')
    },
  },
  url: {
    usage: 'url enc|dec <text>',
    run([mode, ...rest]) {
      const text = rest.join(' ')
      if (!text || !mode) return []
      const r = mode.startsWith('d') ? decodeURIComponent(text) : encodeURIComponent(text)
      return one(cut(r), r, mode.startsWith('d') ? 'URL decoded' : 'URL encoded')
    },
  },
  jwt: {
    usage: 'jwt <token|clipboard>',
    async run([tok], _r, clip) {
      const t = tok === 'clipboard' || !tok ? await clip() : tok
      const { header, payload } = jwtDecode(t)
      const p = JSON.stringify(payload, null, 2)
      const exp = (payload as { exp?: number }).exp
      return [
        {
          title: cut(JSON.stringify(payload)),
          subtitle:
            'JWT payload (decoded offline, signature not verified)' +
            (exp ? ` · exp ${new Date(exp * 1000).toISOString()}` : ''),
          copy: p,
        },
        {
          title: cut(JSON.stringify(header)),
          subtitle: 'JWT header',
          copy: JSON.stringify(header, null, 2),
        },
      ]
    },
  },
  json: {
    usage: 'json [min] (formats clipboard)',
    async run([mode], _r, clip) {
      const v = JSON.parse(await clip())
      const pretty = JSON.stringify(v, null, 2)
      const min = JSON.stringify(v)
      return mode?.startsWith('m')
        ? one(cut(min), min, 'Minified JSON from clipboard')
        : one(cut(min), pretty, 'Formatted JSON from clipboard (copy)')
    },
  },
  ts: {
    usage: 'ts [epoch|ISO date|now]',
    run(args) {
      const t = timestamp(args.join(' '))
      return [
        { title: t.iso, subtitle: 'ISO 8601 (UTC)', copy: t.iso },
        { title: String(t.epoch), subtitle: 'Epoch seconds', copy: String(t.epoch) },
        { title: String(t.ms), subtitle: 'Epoch milliseconds', copy: String(t.ms) },
      ]
    },
  },
  regex: {
    usage: 'regex /pattern/flags text',
    run(_a, raw) {
      const m = /^regex\s+\/((?:\\.|[^/\\])+)\/([a-z]*)\s+([\s\S]+)$/i.exec(raw.trim())
      if (!m) return []
      const r = regexTest(m[1] as string, m[2] as string, m[3] as string)
      if (!r.length) return one('No matches', '', 'regex')
      return r.map((x, i) => ({
        title: x === '' ? '(empty match)' : cut(x),
        subtitle: `Match ${i + 1}`,
        copy: x,
      }))
    },
  },
}
