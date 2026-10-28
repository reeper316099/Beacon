// Benchmark: query latency over 50k synthetic items. Budget: p95 < 16 ms.
import { performance } from 'node:perf_hooks'
import { NameIndexProvider, SearchEngine } from '../src/index'

const words =
  'alpha beta gamma delta report invoice photo backup notes project design budget travel video music chrome firefox terminal editor settings archive'.split(
    ' ',
  )
let seed = 42
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
const pick = () => words[Math.floor(rnd() * words.length)]!
const entries = Array.from({ length: 50_000 }, (_, i) => ({
  id: String(i),
  title: `${pick()}-${pick()} ${pick()}${i % 97}.${['pdf', 'txt', 'png', 'md'][i % 4]}`,
  kind: 'file',
  primary: { id: 'open', title: 'Open', kind: 'open' as const, payload: String(i) },
}))

const p = new NameIndexProvider('files', 'Files')
p.set(entries)
const engine = new SearchEngine({ timeoutMs: 1000 })
engine.register(p)

const queries = [
  'r',
  're',
  'rep',
  'repo',
  'inv',
  'chr',
  'bkp',
  'alpha beta',
  'ph pdf',
  'zzzz',
  'dsgn bdg',
  'term 12',
]
const times: number[] = []
for (let round = 0; round < 6; round++) {
  for (const q of queries) {
    const t = performance.now()
    await engine.search(q, () => {})
    if (round > 0) times.push(performance.now() - t) // round 0 = warm-up
  }
}
times.sort((a, b) => a - b)
const at = (pct: number) => times[Math.min(times.length - 1, Math.floor(times.length * pct))]!
const p95 = at(0.95)
console.log(
  `items=50000 samples=${times.length} p50=${at(0.5).toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${at(0.99).toFixed(2)}ms max=${times[times.length - 1]!.toFixed(2)}ms`,
)
const budget = Number(process.env.BEACON_QUERY_BUDGET_MS ?? 16)
if (p95 > budget) {
  console.warn(`WARN: p95 ${p95.toFixed(2)}ms exceeds budget ${budget}ms`)
  if (process.env.BEACON_ENFORCE_BUDGET) process.exit(1)
}
