/* eslint-disable no-control-regex -- this file exists to match terminal control characters */
/**
 * Output sanitizer: keeps SGR colour sequences (ESC[...m) and drops everything else that could
 * move the cursor, change the title, write the clipboard, or otherwise act as a terminal escape.
 * Streaming-safe: an escape sequence split across chunks is held back until complete.
 */
export class AnsiSanitizer {
  private pending = ''

  push(chunk: string): string {
    let s = this.pending + chunk
    this.pending = ''
    // Hold back a trailing incomplete escape sequence.
    const esc = s.lastIndexOf('\x1b')
    if (esc >= 0 && esc > s.length - 64) {
      const tail = s.slice(esc)
      if (!isComplete(tail)) {
        this.pending = tail
        s = s.slice(0, esc)
      }
    }
    return clean(s)
  }

  flush(): string {
    const rest = this.pending
    this.pending = ''
    return clean(rest.replace(/\x1b/g, ''))
  }
}

function isComplete(tail: string): boolean {
  if (tail.length === 1) return false // lone ESC
  const c = tail[1] as string
  if (c === '[') return /^\x1b\[[0-?]*[ -/]*[@-~]/.test(tail)
  if (c === ']' || c === 'P' || c === '_' || c === '^' || c === 'X')
    return /(\x07|\x1b\\)/.test(tail.slice(2))
  return true
}

export function clean(s: string): string {
  return (
    s
      // OSC / DCS / APC / PM / SOS strings (titles, clipboard, hyperlinks...)
      .replace(/\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
      // CSI: keep only SGR (final byte 'm', digits and ; only)
      .replace(/\x1b\[([0-?]*)([ -/]*)([@-~])/g, (m, params: string, inter: string, fin: string) =>
        fin === 'm' && inter === '' && /^[0-9;]*$/.test(params) ? m : '',
      )
      // any other two-byte escape, and stray ESC
      .replace(/\x1b(?!\[[0-9;]*m)[ -/]*[0-~]?/g, '')
      .replace(/\x1b(?!\[[0-9;]*m)/g, '')
      // 8-bit CSI/OSC introducers
      .replace(/[\x80-\x9f]/g, '')
      // C0 controls except \n \t (CR handled: \r\n → \n, lone \r → \n)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, '')
  )
}

/** Plain text (no colours), e.g. for "copy all". */
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
