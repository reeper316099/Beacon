import { useEffect, useState } from 'react'
import type { BeaconSettings } from './global'
import { applyTheme } from './theme'

export function Settings() {
  const [s, setS] = useState<BeaconSettings | null>(null)
  const [status, setStatus] = useState<Record<string, any> | null>(null)
  const [hk, setHk] = useState('')
  const [hkMsg, setHkMsg] = useState('')

  useEffect(() => {
    void window.beacon.getSettings().then((v) => (setS(v), setHk(v.hotkey), applyTheme(v)))
    void window.beacon.getStatus().then(setStatus)
    return window.beacon.onSettings((v) => (setS(v), applyTheme(v)))
  }, [])
  if (!s) return null

  const patch = async (p: Partial<BeaconSettings>) => {
    const r = await window.beacon.setSettings(p)
    setHkMsg(r.hotkey.ok ? 'Shortcut registered ✓' : r.hotkey.message)
    void window.beacon.getStatus().then(setStatus)
  }
  const hotkey = status?.['hotkey']
  const perf = status?.['perf']

  return (
    <main className="settings">
      <h1>Settings</h1>
      <section>
        <h2>General</h2>
        <label>
          Global shortcut
          <span className="inline">
            <input
              value={hk}
              onChange={(e) => setHk(e.target.value)}
              aria-label="Global shortcut"
            />
            <button onClick={() => patch({ hotkey: hk })}>Apply</button>
          </span>
        </label>
        {(hkMsg || (hotkey && !hotkey.ok)) && <p className="warn">{hkMsg || hotkey.message}</p>}
        <label>
          Theme
          <select value={s.theme} onChange={(e) => patch({ theme: e.target.value as never })}>
            <option value="system">System</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <label>
          Accent
          <input
            type="color"
            value={s.accent}
            onChange={(e) => patch({ accent: e.target.value })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={s.hideOnBlur}
            onChange={(e) => patch({ hideOnBlur: e.target.checked })}
          />
          Hide when it loses focus
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={s.launchAtLogin}
            onChange={(e) => patch({ launchAtLogin: e.target.checked })}
          />
          Launch at login
        </label>
        <label>
          Show on
          <select value={s.display} onChange={(e) => patch({ display: e.target.value as never })}>
            <option value="cursor">Display with the cursor</option>
            <option value="primary">Primary display</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={s.glass}
            onChange={(e) => patch({ glass: e.target.checked })}
          />
          Glass effect (applies after restart; solid surface when unsupported)
        </label>
      </section>
      <section>
        <h2>About &amp; diagnostics</h2>
        <p>
          {status?.['app']} {status?.['version']} · {status?.['platform']}
          {status?.['wayland'] ? ' · Wayland' : ''}
        </p>
        <p className="muted">Data: {status?.['dataDir']}</p>
        {perf && (
          <ul className="muted">
            <li>Cold start to ready: {perf.coldStartMs} ms</li>
            <li>
              App index:{' '}
              {perf.worker ? `${perf.worker.apps} apps in ${perf.worker.ms} ms` : 'indexing…'}
            </li>
            <li>
              Hotkey → visible p50: {perf.hotkeyToVisibleMs.p50 ?? '–'} ms (n=
              {perf.hotkeyToVisibleMs.n})
            </li>
            <li>
              Keystroke → painted p50: {perf.keystrokeToPaintMs.p50?.toFixed?.(1) ?? '–'} ms (n=
              {perf.keystrokeToPaintMs.n})
            </li>
            <li>Memory (all processes): {perf.rssMB} MB</li>
          </ul>
        )}
        <p className="muted">No telemetry. No network calls. Everything stays on this machine.</p>
      </section>
    </main>
  )
}
