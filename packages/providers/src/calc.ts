import { create, all, type MathJsInstance } from 'mathjs'

export interface CalcResult {
  /** Machine-friendly value (what "copy raw" copies). */
  raw: string
  /** Human-friendly formatting. */
  formatted: string
  kind: 'math' | 'unit' | 'percent' | 'base' | 'date' | 'timezone'
}

const MAX_EXPR = 200

interface Sandbox {
  evaluate(expr: string): unknown
  format(v: unknown, o: { precision: number }): string
}
let _math: Sandbox | undefined
/** Restricted mathjs: no import/createUnit/parse/evaluate, no unbounded-cost functions. */
function math(): Sandbox {
  if (_math) return _math
  const m: MathJsInstance = create(all!)
  // Keep private handles; the instance's own evaluate/parse/import are disabled below.
  const evaluate = m.evaluate.bind(m)
  const format = m.format.bind(m)
  const deny = (name: string) => () => {
    throw new Error(`${name} is disabled`)
  }
  const blocked = [
    'import',
    'createUnit',
    'evaluate',
    'parse',
    'simplify',
    'derivative',
    'resolve',
    'compile',
    'reviver',
    'help',
    'chain',
    'factorial',
    'gamma',
    'lgamma',
    'combinations',
    'combinationsWithRep',
    'permutations',
    'multinomial',
    'stirlingS2',
    'bellNumbers',
    'catalan',
    'composition',
    'zeros',
    'ones',
    'identity',
    'range',
    'diag',
    'kron',
    'random',
    'randomInt',
    'pickRandom',
    'sort',
    'filter',
    'map',
    'forEach',
    'transpose',
    'det',
    'inv',
    'lusolve',
    'eigs',
    'expm',
    'sqrtm',
    'fft',
    'ifft',
  ]
  const overrides: Record<string, unknown> = {}
  for (const b of blocked) overrides[b] = deny(b)
  m.import(overrides, { override: true })
  return (_math = { evaluate: (e) => evaluate(e), format: (v, o) => format(v, o) })
}

const UNIT_ALIASES: Record<string, string> = {
  fahrenheit: 'degF',
  celsius: 'degC',
  kelvin: 'K',
  f: 'degF',
  c: 'degC',
  miles: 'mile',
  mph: 'mile/hour',
  kph: 'km/hour',
  kmh: 'km/hour',
  kmph: 'km/hour',
  lbs: 'lb',
  pounds: 'lb',
  kilos: 'kg',
  gb: 'GB',
  mb: 'MB',
  kb: 'kB',
  tb: 'TB',
}

function normalizeUnits(expr: string): string {
  return expr
    .replace(/\b(to|in)\s+([A-Za-z]+)\b/gi, (_m, kw: string, u: string) => {
      return `${kw} ${UNIT_ALIASES[u.toLowerCase()] ?? u}`
    })
    .replace(
      /(\d)\s*(fahrenheit|celsius|kelvin|mph|kph|kmh)\b/gi,
      (_m, n: string, u: string) => `${n} ${UNIT_ALIASES[u.toLowerCase()] ?? u}`,
    )
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  const abs = Math.abs(v)
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-6)) return v.toExponential(6)
  return String(Number(v.toPrecision(12)))
}

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

function evalMath(expr: string): CalcResult | null {
  if (!/[\d]/.test(expr) && !/\b(pi|e|tau|phi)\b/i.test(expr)) return null
  // Plain-English → mathjs
  const src = normalizeUnits(expr)
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/\bmod\b/g, ' mod ')
  // A bare word like "chrome" must not become a symbol lookup; require some operator/number/call.
  if (!/[\d()+\-*/^%]/.test(src)) return null
  let v: unknown
  try {
    v = math().evaluate(src)
  } catch {
    return null
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null
    const raw = fmt(v)
    // Don't echo a literal number back as a "result".
    if (/^[\d.,\s]+$/.test(expr.trim()) && Number(expr.replace(/[,\s]/g, '')) === v) return null
    const [i, d] = raw.split('.')
    return {
      raw,
      formatted: /e/.test(raw) ? raw : group(i as string) + (d ? '.' + d : ''),
      kind: 'math',
    }
  }
  if (v && typeof v === 'object' && 'units' in (v as object)) {
    const s = math().format(v, { precision: 8 })
    return { raw: s, formatted: s, kind: 'unit' }
  }
  return null
}

function parseNum(s: string): number | null {
  const t = s.replace(/_/g, '').toLowerCase()
  if (/^0x[0-9a-f]+$/.test(t)) return parseInt(t.slice(2), 16)
  if (/^0b[01]+$/.test(t)) return parseInt(t.slice(2), 2)
  if (/^0o[0-7]+$/.test(t)) return parseInt(t.slice(2), 8)
  if (/^\d+$/.test(t)) return Number(t)
  return null
}

function evalBase(expr: string): CalcResult | null {
  const m = /^(\S+)\s+(?:to|in|as)\s+(hex|bin|oct|dec|decimal|binary|hexadecimal|octal)$/i.exec(
    expr,
  )
  if (!m) return null
  const n = parseNum(m[1] as string)
  if (n === null || !Number.isSafeInteger(n)) return null
  const t = (m[2] as string).toLowerCase()
  const out = t.startsWith('hex')
    ? '0x' + n.toString(16)
    : t.startsWith('bin')
      ? '0b' + n.toString(2)
      : t.startsWith('oct')
        ? '0o' + n.toString(8)
        : String(n)
  return { raw: out, formatted: out, kind: 'base' }
}

function evalPercent(expr: string): CalcResult | null {
  const m = /^(-?[\d.]+)\s*%\s+(of|off|on)\s+(-?[\d.]+)$/i.exec(expr)
  if (!m) return null
  const p = Number(m[1])
  const b = Number(m[3])
  if (!Number.isFinite(p) || !Number.isFinite(b)) return null
  const op = (m[2] as string).toLowerCase()
  const v = op === 'of' ? (b * p) / 100 : op === 'off' ? b - (b * p) / 100 : b + (b * p) / 100
  return { raw: fmt(v), formatted: group(fmt(v)), kind: 'percent' }
}

const UNITS_MS: Record<string, [string, number]> = {
  minute: ['minutes', 60_000],
  hour: ['hours', 3_600_000],
  day: ['days', 86_400_000],
  week: ['weeks', 604_800_000],
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const fmtDate = (d: Date, time: boolean) =>
  `${DAYS[d.getDay()]}, ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` +
  (time
    ? ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : '')

export function evalDate(expr: string, now: Date): CalcResult | null {
  let m =
    /^(today|now|tomorrow|yesterday)?\s*([+-])\s*(\d+)\s*(minute|hour|day|week|month|year)s?$/i.exec(
      expr,
    )
  let base: Date, sign: number, n: number, unit: string
  if (m) {
    base = new Date(now)
    const w = (m[1] ?? 'today').toLowerCase()
    if (w === 'tomorrow') base.setDate(base.getDate() + 1)
    if (w === 'yesterday') base.setDate(base.getDate() - 1)
    sign = m[2] === '-' ? -1 : 1
    n = Number(m[3])
    unit = (m[4] as string).toLowerCase()
    if (!m[1]) return null
  } else {
    m = /^(\d+)\s*(minute|hour|day|week|month|year)s?\s+(ago|from now)$/i.exec(expr)
    if (!m) return null
    base = new Date(now)
    sign = (m[3] as string).toLowerCase() === 'ago' ? -1 : 1
    n = Number(m[1])
    unit = (m[2] as string).toLowerCase()
  }
  if (n > 100_000) return null
  const d = new Date(base)
  if (unit === 'month') d.setMonth(d.getMonth() + sign * n)
  else if (unit === 'year') d.setFullYear(d.getFullYear() + sign * n)
  else d.setTime(d.getTime() + sign * n * (UNITS_MS[unit] as [string, number])[1])
  if (Number.isNaN(d.getTime())) return null
  const time = ['minute', 'hour'].includes(unit) || /^now/i.test(expr)
  const s = fmtDate(d, time)
  return { raw: s, formatted: s, kind: 'date' }
}

const ZONES: Record<string, string> = {
  utc: 'UTC',
  gmt: 'UTC',
  z: 'UTC',
  pst: 'America/Los_Angeles',
  pdt: 'America/Los_Angeles',
  pt: 'America/Los_Angeles',
  mst: 'America/Denver',
  mdt: 'America/Denver',
  mt: 'America/Denver',
  cst: 'America/Chicago',
  cdt: 'America/Chicago',
  ct: 'America/Chicago',
  est: 'America/New_York',
  edt: 'America/New_York',
  et: 'America/New_York',
  cet: 'Europe/Paris',
  cest: 'Europe/Paris',
  bst: 'Europe/London',
  jst: 'Asia/Tokyo',
  ist: 'Asia/Kolkata',
  aest: 'Australia/Sydney',
  nyc: 'America/New_York',
  sf: 'America/Los_Angeles',
  la: 'America/Los_Angeles',
  london: 'Europe/London',
  paris: 'Europe/Paris',
  berlin: 'Europe/Berlin',
  tokyo: 'Asia/Tokyo',
  sydney: 'Australia/Sydney',
  mumbai: 'Asia/Kolkata',
  delhi: 'Asia/Kolkata',
  dubai: 'Asia/Dubai',
  singapore: 'Asia/Singapore',
  seoul: 'Asia/Seoul',
  shanghai: 'Asia/Shanghai',
  'hong kong': 'Asia/Hong_Kong',
}

export function resolveZone(name: string): string | null {
  const k = name.trim().toLowerCase()
  if (ZONES[k]) return ZONES[k] as string
  let zones: string[] = []
  try {
    zones = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf(
      'timeZone',
    )
  } catch {
    return null
  }
  const exact = zones.find((z) => z.toLowerCase() === k)
  if (exact) return exact
  const city = k.replace(/\s+/g, '_')
  return zones.find((z) => z.toLowerCase().endsWith('/' + city)) ?? null
}

function offsetMs(zone: string, at: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  )
  const asUtc = Date.UTC(
    +p['year']!,
    +p['month']! - 1,
    +p['day']!,
    +p['hour']!,
    +p['minute']!,
    +p['second']!,
  )
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** Interpret a wall-clock time (on `day`'s date in `zone`) as an instant. */
export function zonedWallToDate(
  zone: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
): Date {
  let t = Date.UTC(y, mo, d, h, mi)
  for (let i = 0; i < 2; i++) t = Date.UTC(y, mo, d, h, mi) - offsetMs(zone, new Date(t))
  return new Date(t)
}

export function evalTimezone(expr: string, now: Date): CalcResult | null {
  const m =
    /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+([A-Za-z_/ ]+?)\s+(?:in|to)\s+([A-Za-z_/ ]+)$/i.exec(expr)
  if (!m) return null
  let h = Number(m[1])
  const mi = Number(m[2] ?? 0)
  const ap = m[3]?.toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  if (h > 23 || mi > 59) return null
  const from = resolveZone(m[4] as string)
  const to = resolveZone(m[5] as string)
  if (!from || !to) return null
  const inst = zonedWallToDate(from, now.getFullYear(), now.getMonth(), now.getDate(), h, mi)
  const out = new Intl.DateTimeFormat('en-US', {
    timeZone: to,
    hour: 'numeric',
    minute: '2-digit',
    weekday: 'short',
    timeZoneName: 'short',
  }).format(inst)
  return { raw: out, formatted: out, kind: 'timezone' }
}

/** Try every evaluator; `null` when the input isn't something we can compute. */
export function calculate(input: string, now: Date = new Date()): CalcResult | null {
  const expr = input.trim()
  if (!expr || expr.length > MAX_EXPR || /[[\]{};=`\\]/.test(expr)) return null
  return (
    evalPercent(expr) ??
    evalBase(expr) ??
    evalDate(expr, now) ??
    evalTimezone(expr, now) ??
    evalMath(expr)
  )
}

/** Manual currency rates (no network): "100 usd to eur" using a user-edited table of rates per USD. */
export function convertCurrency(input: string, rates: Record<string, number>): CalcResult | null {
  const m = /^([\d.]+)\s*([a-z]{3})\s+(?:to|in)\s+([a-z]{3})$/i.exec(input.trim())
  if (!m) return null
  const a = rates[(m[2] as string).toUpperCase()]
  const b = rates[(m[3] as string).toUpperCase()]
  if (!a || !b) return null
  const v = (Number(m[1]) / a) * b
  return {
    raw: fmt(v),
    formatted: `${group(fmt(v))} ${(m[3] as string).toUpperCase()}`,
    kind: 'unit',
  }
}
