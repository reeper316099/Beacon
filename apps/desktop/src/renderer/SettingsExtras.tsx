import { useEffect, useState } from 'react'

type Step = { kind: string; [k: string]: unknown }
interface Wf {
  id: string
  name: string
  keyword: string
  description?: string
  args: { name: string; prompt?: string; default?: string }[]
  steps: Step[]
}
const KINDS: Record<string, { field: string; label: string }[]> = {
  url: [{ field: 'url', label: 'URL (https://…{query})' }],
  open: [{ field: 'path', label: 'Absolute path' }],
  app: [{ field: 'name', label: 'App name' }],
  copy: [{ field: 'text', label: 'Text' }],
  run: [
    { field: 'file', label: 'Program' },
    { field: 'args', label: 'Arguments (one per line)' },
  ],
  wait: [{ field: 'ms', label: 'Milliseconds' }],
  script: [
    { field: 'script', label: 'Script keyword or name' },
    { field: 'args', label: 'Arguments (one per line)' },
  ],
}
const blank = (): Wf => ({
  id: 'my-workflow',
  name: 'My workflow',
  keyword: 'mw',
  args: [{ name: 'query' }],
  steps: [{ kind: 'url', url: 'https://example.com/?q={query}' }],
})

export function WorkflowsSection() {
  const [files, setFiles] = useState<Awaited<ReturnType<typeof window.beacon.listWorkflows>>>([])
  const [file, setFile] = useState<string>('')
  const [wf, setWf] = useState<Wf>(blank())
  const [raw, setRaw] = useState('')
  const [rawMode, setRawMode] = useState(false)
  const [msg, setMsg] = useState('')

  const refresh = () => void window.beacon.listWorkflows().then(setFiles)
  useEffect(refresh, [])

  const load = (f: (typeof files)[number] | null) => {
    setMsg('')
    if (!f) {
      const w = blank()
      setFile(w.id + '.json')
      setWf(w)
      setRaw(JSON.stringify(w, null, 2))
      return
    }
    setFile(f.file)
    setRaw(f.raw)
    try {
      setWf(JSON.parse(f.raw) as Wf)
    } catch {
      setRawMode(true) // YAML or invalid: edit as raw text
    }
  }
  const toRaw = (w: Wf) => JSON.stringify(w, null, 2)
  const update = (w: Wf) => {
    setWf(w)
    setRaw(toRaw(w))
  }
  const save = async () => {
    const r = await window.beacon.saveWorkflow(file, rawMode ? raw : toRaw(wf))
    setMsg(r.ok ? 'Saved ✓' : `Not saved: ${r.error}`)
    if (r.ok) refresh()
  }

  return (
    <section>
      <h2>Workflows</h2>
      <p className="muted">
        No-code commands: a keyword plus steps (open URL / file / app, copy text, run a program,
        wait, run a trusted script). Files live in the <code>workflows</code> folder as JSON or
        YAML; edit them here or by hand.
      </p>
      <div className="inline">
        <select
          value={file}
          onChange={(e) => load(files.find((f) => f.file === e.target.value) ?? null)}
          aria-label="Workflow"
        >
          <option value="">Choose…</option>
          {files.map((f) => (
            <option key={f.file} value={f.file}>
              {f.ok ? `${f.name} (${f.keyword})` : `⚠ ${f.file}`}
            </option>
          ))}
        </select>
        <button onClick={() => load(null)}>New</button>
        {file && files.some((f) => f.file === file) && (
          <button
            onClick={() =>
              void window.beacon.deleteWorkflow(file).then(() => {
                refresh()
                setFile('')
              })
            }
          >
            Delete
          </button>
        )}
      </div>
      {files
        .filter((f) => !f.ok)
        .map((f) => (
          <p key={f.file} className="warn">
            {f.file}: {f.error}
          </p>
        ))}
      {file && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={rawMode}
              onChange={(e) => {
                setRawMode(e.target.checked)
                if (!e.target.checked) {
                  try {
                    setWf(JSON.parse(raw) as Wf)
                  } catch {
                    setMsg('Raw text is not valid JSON; staying in raw mode')
                    setRawMode(true)
                  }
                }
              }}
            />{' '}
            Edit raw file
          </label>
          {rawMode ? (
            <textarea
              className="raw"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              spellCheck={false}
              aria-label="Raw workflow"
            />
          ) : (
            <div className="wfform">
              <label>
                File name
                <input value={file} onChange={(e) => setFile(e.target.value)} />
              </label>
              <label>
                Id
                <input value={wf.id} onChange={(e) => update({ ...wf, id: e.target.value })} />
              </label>
              <label>
                Name
                <input value={wf.name} onChange={(e) => update({ ...wf, name: e.target.value })} />
              </label>
              <label>
                Keyword
                <input
                  value={wf.keyword}
                  onChange={(e) => update({ ...wf, keyword: e.target.value })}
                />
              </label>
              <label>
                Arguments (names, comma separated; typed after the keyword)
                <input
                  value={wf.args.map((a) => a.name).join(', ')}
                  onChange={(e) =>
                    update({
                      ...wf,
                      args: e.target.value
                        .split(',')
                        .map((n) => n.trim())
                        .filter(Boolean)
                        .map((name) => ({ name })),
                    })
                  }
                />
              </label>
              <h3>Steps</h3>
              {wf.steps.map((st, i) => (
                <div className="step" key={i}>
                  <select
                    value={st.kind}
                    onChange={(e) =>
                      update({
                        ...wf,
                        steps: wf.steps.map((x, j) => (j === i ? { kind: e.target.value } : x)),
                      })
                    }
                  >
                    {Object.keys(KINDS).map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </select>
                  {KINDS[st.kind]?.map((f) => (
                    <label key={f.field}>
                      {f.label}
                      <input
                        value={
                          f.field === 'args'
                            ? ((st['args'] as string[]) ?? []).join('\n').replace(/\n/g, ' ⏎ ')
                            : String(st[f.field] ?? '')
                        }
                        onChange={(e) =>
                          update({
                            ...wf,
                            steps: wf.steps.map((x, j) =>
                              j === i
                                ? {
                                    ...x,
                                    [f.field]:
                                      f.field === 'args'
                                        ? e.target.value.split(/\s*⏎\s*/)
                                        : f.field === 'ms'
                                          ? Number(e.target.value) || 0
                                          : e.target.value,
                                  }
                                : x,
                            ),
                          })
                        }
                      />
                    </label>
                  ))}
                  <button
                    onClick={() => update({ ...wf, steps: wf.steps.filter((_, j) => j !== i) })}
                    aria-label="Remove step"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                onClick={() => update({ ...wf, steps: [...wf.steps, { kind: 'copy', text: '' }] })}
              >
                + Add step
              </button>
              <p className="muted">
                Workflows with “run” or “script” steps ask for confirmation each time. Use ⏎ to
                separate arguments.
              </p>
            </div>
          )}
          <div className="inline">
            <button onClick={() => void save()}>Save</button>
            <span className="muted">{msg}</span>
          </div>
        </>
      )}
    </section>
  )
}

export function ExtensionsSection() {
  const [list, setList] = useState<Awaited<ReturnType<typeof window.beacon.listExtensions>>>([])
  const refresh = () => void window.beacon.listExtensions().then(setList)
  useEffect(refresh, [])
  const act = (op: string, id: string) => void window.beacon.extensionAction(op, id).then(refresh)
  return (
    <section>
      <h2>Extensions</h2>
      <p className="warn">
        Extensions are not signed or reviewed. Only install extensions you trust. They run in an
        isolated sandbox with no access except what you approve below (network is off by default).
      </p>
      {list.length === 0 && (
        <p className="muted">
          None installed. Put an extension folder (manifest.json + code) in the extensions folder.
        </p>
      )}
      {list.map((e) => (
        <div className="ext" key={e.id}>
          <strong>{e.name}</strong>{' '}
          <span className="muted">
            {e.version} · {e.state}
          </span>
          {e.error && <p className="warn">{e.error}</p>}
          <ul className="muted">
            {e.permissions.length ? (
              e.permissions.map((p) => <li key={p}>{p}</li>)
            ) : (
              <li>no special permissions</li>
            )}
          </ul>
          <div className="inline">
            {e.state === 'invalid' ? null : e.state === 'enabled' || e.state === 'restarting' ? (
              <button onClick={() => act('disable', e.id)}>Disable</button>
            ) : (
              <button onClick={() => act('enable', e.id)}>Review permissions & enable</button>
            )}
            <button onClick={() => act('reload', e.id)}>Reload</button>
            <button onClick={() => act('remove', e.id)}>Remove</button>
          </div>
        </div>
      ))}
      <div className="inline">
        <button onClick={() => act('open-folder', '_')}>Open extensions folder</button>
      </div>
    </section>
  )
}

export function ScriptsSection() {
  return (
    <section>
      <h2>Scripts</h2>
      <p className="muted">
        Every script in your script folders becomes a command. Add a folder from the launcher with{' '}
        <code>script add /path/to/folder</code> or edit <code>config/scripts.json</code>{' '}
        (interpreters, working directory, environment allow-list, timeouts, run history). Scripts
        are never run automatically; the first run and any run after an edit asks you to approve
        that exact version.
      </p>
      <div className="inline">
        <button onClick={() => void window.beacon.openScriptsFolder()}>
          Open default scripts folder
        </button>
      </div>
    </section>
  )
}

export function ProvidersSection() {
  const [list, setList] = useState<Awaited<ReturnType<typeof window.beacon.listProviders>>>([])
  useEffect(() => void window.beacon.listProviders().then(setList), [])
  return (
    <section>
      <h2>Providers</h2>
      <p className="muted">
        Switch features on or off. Triggers are the prefixes that focus a provider (for example{' '}
        <code>cb </code> for clipboard history).
      </p>
      <div className="grid">
        {list.map((p) => (
          <label key={p.id} className="check">
            <input
              type="checkbox"
              checked={p.enabled}
              onChange={(e) => {
                setList(list.map((x) => (x.id === p.id ? { ...x, enabled: e.target.checked } : x)))
                void window.beacon.setProvider(p.id, e.target.checked)
              }}
            />
            <span>
              {p.name}
              {p.triggers[0] ? (
                <small className="muted"> · {p.triggers.map((t) => t.trim()).join(', ')}</small>
              ) : null}
            </span>
          </label>
        ))}
      </div>
    </section>
  )
}
