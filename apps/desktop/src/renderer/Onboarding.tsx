import { useEffect, useState } from 'react'
import type { BeaconSettings } from './global'
import { applyTheme } from './theme'

type Status = Record<string, any>
const STEPS = ['Shortcut', 'Files', 'Features', 'Your apps', 'Quick tour'] as const

export function Onboarding() {
  const [step, setStep] = useState(0)
  const [s, setS] = useState<BeaconSettings | null>(null)
  const [status, setStatus] = useState<Status | null>(null)

  useEffect(() => {
    void window.beacon.getSettings().then((v) => (setS(v), applyTheme(v)))
    void window.beacon.getStatus().then(setStatus)
  }, [])
  if (!s) return null

  const last = step === STEPS.length - 1
  return (
    <main className="settings onboarding" aria-labelledby="ob-title">
      <h1 id="ob-title">Welcome to Beacon</h1>
      <ol className="steps" aria-label="Setup progress">
        {STEPS.map((n, i) => (
          <li
            key={n}
            aria-current={i === step ? 'step' : undefined}
            className={i === step ? 'on' : i < step ? 'done' : ''}
          >
            {n}
          </li>
        ))}
      </ol>
      {step === 0 && (
        <HotkeyStep
          s={s}
          setS={setS}
          status={status}
          refresh={() => void window.beacon.getStatus().then(setStatus)}
        />
      )}
      {step === 1 && <FilesStep />}
      {step === 2 && <FeaturesStep />}
      {step === 3 && <AppsStep />}
      {step === 4 && <TourStep hotkey={s.hotkey} wayland={!!status?.['wayland']} />}
      <div className="inline nav">
        <button onClick={() => void window.beacon.finishOnboarding()}>Skip setup</button>
        <span style={{ flex: 1 }} />
        {step > 0 && <button onClick={() => setStep(step - 1)}>Back</button>}
        <button
          className="primary"
          onClick={() => (last ? void window.beacon.finishOnboarding() : setStep(step + 1))}
        >
          {last ? 'Finish' : 'Next'}
        </button>
      </div>
    </main>
  )
}

function HotkeyStep({
  s,
  setS,
  status,
  refresh,
}: {
  s: BeaconSettings
  setS: (v: BeaconSettings) => void
  status: Status | null
  refresh: () => void
}) {
  const [hk, setHk] = useState(s.hotkey)
  const [msg, setMsg] = useState('')
  const wayland = !!status?.['wayland']
  const apply = async () => {
    const r = await window.beacon.setSettings({ hotkey: hk })
    setS(r.settings)
    setMsg(r.hotkey.ok ? 'Shortcut registered ✓' : r.hotkey.message)
    refresh()
  }
  const hotkey = status?.['hotkey']
  return (
    <section>
      <h2>Pick your shortcut</h2>
      <p>
        Press it anywhere to summon Beacon. Examples: <code>Alt+Space</code>,{' '}
        <code>Ctrl+Shift+Space</code>, <code>Cmd+Alt+K</code>.
      </p>
      <label>
        Global shortcut
        <span className="inline">
          <input value={hk} onChange={(e) => setHk(e.target.value)} aria-label="Global shortcut" />
          <button onClick={() => void apply()}>Apply &amp; test</button>
        </span>
      </label>
      {(msg || (hotkey && !hotkey.ok)) && (
        <p className={msg.endsWith('✓') ? 'ok' : 'warn'} role="status">
          {msg || hotkey.message}
        </p>
      )}
      {wayland && (
        <div className="note" role="note">
          <strong>You're on Wayland.</strong> Apps can't register global shortcuts there. In your
          desktop's keyboard settings, add a custom shortcut that runs
          <code>beacon toggle</code> (GNOME: Settings → Keyboard → Custom Shortcuts; KDE: Shortcuts
          → Add Command; Sway: <code>bindsym Alt+space exec beacon toggle</code>).
        </div>
      )}
    </section>
  )
}

function FilesStep() {
  const [roots, setRoots] = useState<string[]>([])
  useEffect(() => void window.beacon.getFileRoots().then(setRoots), [])
  const save = (r: string[]) => {
    setRoots(r)
    void window.beacon.setFileRoots(r)
  }
  return (
    <section>
      <h2>Where should Beacon look for files?</h2>
      <p className="muted">
        Only file <em>names</em> are indexed, locally, in the background. Common folders like{' '}
        <code>node_modules</code> and <code>.git</code> are skipped.
      </p>
      <ul className="list">
        {roots.map((r) => (
          <li key={r}>
            <code>{r}</code>{' '}
            <button onClick={() => save(roots.filter((x) => x !== r))} aria-label={`Remove ${r}`}>
              Remove
            </button>
          </li>
        ))}
        {roots.length === 0 && <li className="muted">No folders: file search is off.</li>}
      </ul>
      <button
        onClick={() =>
          void window.beacon
            .pickFolder()
            .then((p) => p && !roots.includes(p) && save([...roots, p]))
        }
      >
        Add folder…
      </button>
    </section>
  )
}

function FeaturesStep() {
  const [list, setList] = useState<Awaited<ReturnType<typeof window.beacon.listProviders>>>([])
  useEffect(() => void window.beacon.listProviders().then(setList), [])
  const toggle = (id: string, enabled: boolean) => {
    setList(list.map((p) => (p.id === id ? { ...p, enabled } : p)))
    void window.beacon.setProvider(id, enabled)
  }
  return (
    <section>
      <h2>Choose what Beacon can do</h2>
      <p className="muted">
        Everything is off the network and on your machine. Switch off anything you don't want; you
        can change this later in Settings.
      </p>
      <div className="grid">
        {list.map((p) => (
          <label key={p.id} className="check">
            <input
              type="checkbox"
              checked={p.enabled}
              onChange={(e) => toggle(p.id, e.target.checked)}
            />
            <span>
              {p.name}
              {p.triggers[0] ? <small className="muted"> · {p.triggers[0].trim()}</small> : null}
            </span>
          </label>
        ))}
      </div>
    </section>
  )
}

function AppsStep() {
  const [apps, setApps] = useState<Awaited<ReturnType<typeof window.beacon.detectIntegrations>>>([])
  const refresh = () => void window.beacon.detectIntegrations().then(setApps)
  useEffect(refresh, [])
  return (
    <section>
      <h2>
        Connect your apps <span className="muted">(optional)</span>
      </h2>
      <p className="muted">
        Beacon can search Lorekeeper, Cipherkeep, Worldloom and Classpad, read-only. Spoiler-gated
        Worldloom pages and Classpad grades never appear.
      </p>
      {apps.map((a) => (
        <label key={a.id} className="check">
          <input
            type="checkbox"
            disabled={!a.found}
            checked={a.enabled}
            onChange={(e) =>
              void window.beacon.setIntegration(a.id, e.target.checked).then(refresh)
            }
          />
          <span>
            {a.name}{' '}
            {a.found ? (
              <small className="muted">· data folder found</small>
            ) : (
              <small className="muted">· not found on this computer</small>
            )}
          </span>
        </label>
      ))}
    </section>
  )
}

function TourStep({ hotkey, wayland }: { hotkey: string; wayland: boolean }) {
  const [shown, setShown] = useState(false)
  const [typed, setTyped] = useState(false)
  useEffect(() => {
    const a = window.beacon.onLauncherShown(() => setShown(true))
    const b = window.beacon.onLauncherTyped(() => setTyped(true))
    return () => (a(), b())
  }, [])
  return (
    <section>
      <h2>Try it (20 seconds)</h2>
      <ol className="tour">
        <li className={shown ? 'ok' : ''}>
          {shown ? '✓' : '1.'}{' '}
          {wayland ? (
            <>
              Run <code>beacon toggle</code> from a terminal or your shortcut
            </>
          ) : (
            <>
              Press <kbd>{hotkey}</kbd>
            </>
          )}{' '}
          to open Beacon.
        </li>
        <li className={typed ? 'ok' : ''}>
          {typed ? '✓' : '2.'} Start typing: an app name, <code>23*1.08</code>, <code>g cats</code>,
          or <code>timer 5m</code>.
        </li>
        <li>
          3. <kbd>↵</kbd> runs the top result, <kbd>Tab</kbd> shows more actions, <kbd>Esc</kbd>{' '}
          goes back, <kbd>Ctrl/⌘ P</kbd> pins.
        </li>
        <li>
          4. Type <code>hub</code> to connect your apps, <code>script new py hello</code> for a
          script, <code>ext</code> for extensions, <code>cb </code> for clipboard history.
        </li>
      </ol>
      <p className="muted">
        Settings (tray menu) has everything else. Nothing here uses the network.
      </p>
    </section>
  )
}
