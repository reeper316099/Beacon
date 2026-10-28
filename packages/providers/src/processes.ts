export interface Proc {
  pid: number
  name: string
}

const CRITICAL = new Set([
  'launchd',
  'kernel_task',
  'windowserver',
  'loginwindow',
  'systemd',
  'init',
  'kthreadd',
  'dbus-daemon',
  'system',
  'smss.exe',
  'csrss.exe',
  'wininit.exe',
  'winlogon.exe',
  'services.exe',
  'lsass.exe',
  'svchost.exe',
  'dwm.exe',
  'explorer.exe',
  'registry',
  'xorg',
  'gnome-shell',
  'sshd',
])

export function isCritical(p: Proc, selfPids: number[] = []): boolean {
  return p.pid <= 1 || selfPids.includes(p.pid) || CRITICAL.has(p.name.toLowerCase())
}

/** `ps -axo pid=,comm=` output. */
export function parsePs(out: string): Proc[] {
  const procs: Proc[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (m) procs.push({ pid: Number(m[1]), name: (m[2] as string).split('/').pop() as string })
  }
  return procs
}

/** `tasklist /FO CSV /NH` output. */
export function parseTasklist(out: string): Proc[] {
  const procs: Proc[] = []
  for (const line of out.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line)
    if (m) procs.push({ pid: Number(m[2]), name: m[1] as string })
  }
  return procs
}

export function filterProcs(all: Proc[], needle: string, selfPids: number[] = []): Proc[] {
  const n = needle.trim().toLowerCase()
  if (!n) return []
  return all
    .filter((p) => p.name.toLowerCase().includes(n) && !isCritical(p, selfPids))
    .sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid)
    .slice(0, 20)
}
