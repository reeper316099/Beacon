import type { Run } from './base'

export interface TerminalConfig {
  /** Linux/other: argv prefix that runs the rest as a command, e.g. ['kitty'] or ['gnome-terminal','--']. */
  command?: string[]
}

/** Host/alias names we are willing to hand to a terminal: no spaces, quotes or shell metacharacters. */
export const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9._@:-]*$/

/**
 * Build argv that opens a terminal running `argv` (no shell strings; the one place text reaches
 * a script language is the macOS AppleScript, so every word is validated and quoted).
 */
export function terminalRun(
  platform: NodeJS.Platform,
  argv: string[],
  cfg: TerminalConfig = {},
): Run {
  if (argv.length === 0) throw new Error('empty command')
  if (cfg.command?.length)
    return { file: cfg.command[0] as string, args: [...cfg.command.slice(1), ...argv] }
  if (platform === 'darwin') {
    for (const a of argv)
      if (!SAFE_HOST.test(a) && !/^[A-Za-z0-9._/-]+$/.test(a))
        throw new Error('unsafe argument for Terminal')
    const line = argv.join(' ')
    return {
      file: 'osascript',
      args: [
        '-e',
        `tell application "Terminal" to activate`,
        '-e',
        `tell application "Terminal" to do script "${line}"`,
      ],
    }
  }
  if (platform === 'win32') return { file: 'wt.exe', args: argv }
  return { file: 'x-terminal-emulator', args: ['-e', ...argv] }
}

/** Open a terminal with its working directory set to `dir`. */
export function terminalHere(
  platform: NodeJS.Platform,
  dir: string,
  cfg: TerminalConfig = {},
): Run {
  if (cfg.command?.length)
    return { file: cfg.command[0] as string, args: cfg.command.slice(1), cwd: dir }
  if (platform === 'darwin') return { file: 'open', args: ['-a', 'Terminal', dir] }
  if (platform === 'win32') return { file: 'wt.exe', args: ['-d', dir] }
  return { file: 'x-terminal-emulator', args: [], cwd: dir }
}
