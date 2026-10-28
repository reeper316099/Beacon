import { performance } from 'node:perf_hooks'
import { searchLean } from '@beacon/matcher'
const words =
  'alpha beta gamma delta report invoice photo backup notes project design budget travel video music chrome firefox terminal editor settings archive'.split(
    ' ',
  )
let seed = 7
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
const pick = () => words[Math.floor(rnd() * words.length)]!
for (const n of [50_000, 300_000]) {
  const names = Array.from({ length: n }, (_, i) => `${pick()}-${pick()} ${pick()}${i % 97}.pdf`)
  const times: number[] = []
  for (const q of [
    'rep',
    'inv',
    'chr',
    'bkp',
    'alpha beta',
    'ph pdf',
    'zzzz',
    'dsgn bdg',
    'term 12',
    'repo',
  ]) {
    searchLean(names, q, 40)
    const t = performance.now()
    searchLean(names, q, 40)
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  console.log(`lean n=${n} p50=${times[5]!.toFixed(1)}ms max=${times[9]!.toFixed(1)}ms`)
}
