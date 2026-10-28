import type { Run } from './base'

export interface SysCommand {
  id: string
  title: string
  keywords: string[]
  confirm: boolean
  steps: Run[]
}

const osa = (script: string): Run => ({ file: 'osascript', args: ['-e', script] })

export function systemCommands(
  platform: NodeJS.Platform,
  user = process.env['USER'] ?? '',
): SysCommand[] {
  const c = (
    id: string,
    title: string,
    keywords: string[],
    confirm: boolean,
    ...steps: Run[]
  ): SysCommand => ({ id, title, keywords, confirm, steps })
  if (platform === 'darwin')
    return [
      c('lock', 'Lock Screen', ['lock'], false, { file: 'pmset', args: ['displaysleepnow'] }),
      c('sleep', 'Sleep', ['suspend'], false, { file: 'pmset', args: ['sleepnow'] }),
      c(
        'logout',
        'Sign Out',
        ['log out', 'logout'],
        true,
        osa('tell application "System Events" to log out'),
      ),
      c('restart', 'Restart', ['reboot'], true, osa('tell application "System Events" to restart')),
      c(
        'shutdown',
        'Shut Down',
        ['power off'],
        true,
        osa('tell application "System Events" to shut down'),
      ),
      c('trash', 'Empty Trash', ['bin'], true, osa('tell application "Finder" to empty trash')),
      c(
        'dark',
        'Toggle Dark Mode',
        ['appearance', 'theme'],
        false,
        osa(
          'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode',
        ),
      ),
      c(
        'hidden-show',
        'Show Hidden Files',
        ['finder'],
        false,
        {
          file: 'defaults',
          args: ['write', 'com.apple.finder', 'AppleShowAllFiles', '-bool', 'true'],
        },
        { file: 'killall', args: ['Finder'] },
      ),
      c(
        'hidden-hide',
        'Hide Hidden Files',
        ['finder'],
        false,
        {
          file: 'defaults',
          args: ['write', 'com.apple.finder', 'AppleShowAllFiles', '-bool', 'false'],
        },
        { file: 'killall', args: ['Finder'] },
      ),
      c('mute', 'Mute Volume', ['sound'], false, osa('set volume output muted true')),
      c('unmute', 'Unmute Volume', ['sound'], false, osa('set volume output muted false')),
      c('settings', 'Open System Settings', ['preferences'], false, {
        file: 'open',
        args: ['x-apple.systempreferences:'],
      }),
    ]
  if (platform === 'win32')
    return [
      c('lock', 'Lock Screen', ['lock'], false, {
        file: 'rundll32.exe',
        args: ['user32.dll,LockWorkStation'],
      }),
      c('sleep', 'Sleep', ['suspend'], false, {
        file: 'rundll32.exe',
        args: ['powrprof.dll,SetSuspendState', '0,1,0'],
      }),
      c('logout', 'Sign Out', ['log out', 'logout'], true, { file: 'shutdown', args: ['/l'] }),
      c('restart', 'Restart', ['reboot'], true, { file: 'shutdown', args: ['/r', '/t', '0'] }),
      c('shutdown', 'Shut Down', ['power off'], true, {
        file: 'shutdown',
        args: ['/s', '/t', '0'],
      }),
      c('trash', 'Empty Recycle Bin', ['trash', 'bin'], true, {
        file: 'powershell.exe',
        args: ['-NoProfile', '-Command', 'Clear-RecycleBin -Force'],
      }),
      c('settings', 'Open Settings', ['preferences'], false, {
        file: 'explorer.exe',
        args: ['ms-settings:'],
      }),
    ]
  return [
    c('lock', 'Lock Screen', ['lock'], false, { file: 'loginctl', args: ['lock-session'] }),
    c('sleep', 'Sleep', ['suspend'], false, { file: 'systemctl', args: ['suspend'] }),
    ...(user
      ? [
          c('logout', 'Sign Out', ['log out', 'logout'], true, {
            file: 'loginctl',
            args: ['terminate-user', user],
          }),
        ]
      : []),
    c('restart', 'Restart', ['reboot'], true, { file: 'systemctl', args: ['reboot'] }),
    c('shutdown', 'Shut Down', ['power off'], true, { file: 'systemctl', args: ['poweroff'] }),
    c('trash', 'Empty Trash', ['bin'], true, { file: 'gio', args: ['trash', '--empty'] }),
  ]
}
