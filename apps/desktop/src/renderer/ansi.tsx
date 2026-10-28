import type { ReactNode } from 'react'

const COLORS = [
  '#3b4252',
  '#e06c75',
  '#98c379',
  '#e5c07b',
  '#61afef',
  '#c678dd',
  '#56b6c2',
  '#abb2bf',
  '#5c6370',
  '#ff7b86',
  '#b5e890',
  '#ffd98a',
  '#7cc4ff',
  '#dd9bff',
  '#7fdbe6',
  '#ffffff',
]

interface Style {
  fg?: number
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

/** Render sanitized text (only SGR sequences can be present) as styled spans. */
export function renderAnsi(text: string, base: 'out' | 'err'): ReactNode[] {
  const nodes: ReactNode[] = []
  let st: Style = {}
  let last = 0
  const re = /\x1b\[([0-9;]*)m/g // eslint-disable-line no-control-regex
  const push = (s: string, key: number) => {
    if (!s) return
    const color = st.fg !== undefined ? COLORS[st.fg] : undefined
    nodes.push(
      <span
        key={key}
        className={base === 'err' ? 'err' : undefined}
        style={{
          ...(color ? { color } : {}),
          ...(st.bold ? { fontWeight: 700 } : {}),
          ...(st.dim ? { opacity: 0.65 } : {}),
          ...(st.italic ? { fontStyle: 'italic' } : {}),
          ...(st.underline ? { textDecoration: 'underline' } : {}),
        }}
      >
        {s}
      </span>,
    )
  }
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index), k++)
    last = m.index + m[0].length
    const codes = (m[1] || '0').split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i] as number
      if (c === 0) st = {}
      else if (c === 1) st = { ...st, bold: true }
      else if (c === 2) st = { ...st, dim: true }
      else if (c === 3) st = { ...st, italic: true }
      else if (c === 4) st = { ...st, underline: true }
      else if (c === 22) st = { ...st, bold: false, dim: false }
      else if (c >= 30 && c <= 37) st = { ...st, fg: c - 30 }
      else if (c >= 90 && c <= 97) st = { ...st, fg: c - 90 + 8 }
      else if (c === 39) {
        const { fg: _fg, ...rest } = st
        void _fg
        st = rest
      } else if (c === 38) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0 // 256/truecolor: skip params
    }
  }
  push(text.slice(last), k++)
  return nodes
}

export const stripSgr = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '') // eslint-disable-line no-control-regex
