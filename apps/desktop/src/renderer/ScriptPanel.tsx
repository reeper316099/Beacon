import { useEffect, useRef, useState } from 'react'
import { renderAnsi, stripSgr } from './ansi'
import { useStore, type ScriptRun } from './store'

const mod = () => (navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl')

function Badge({ run }: { run: ScriptRun }) {
  if (run.status === 'done' && run.exit) {
    const e = run.exit
    const secs = (e.durationMs / 1000).toFixed(e.durationMs < 10_000 ? 1 : 0) + 's'
    const label = e.timedOut
      ? 'timed out'
      : e.cancelled
        ? 'cancelled'
        : e.error
          ? 'failed to start'
          : `exit ${e.exitCode ?? e.signal}`
    const ok = e.exitCode === 0 && !e.timedOut && !e.cancelled
    return (
      <span className={'badge ' + (ok ? 'ok' : 'bad')}>
        {ok ? '✓' : '✗'} {label} · {secs}
        {e.truncated ? ' · truncated' : ''}
      </span>
    )
  }
  if (run.status === 'running')
    return (
      <span className="badge run">
        <span className="spin" /> running{run.progress?.label ? ` · ${run.progress.label}` : ''}
      </span>
    )
  if (run.status === 'error') return <span className="badge bad">error</span>
  return (
    <span className="badge">
      {run.status === 'confirm'
        ? 'needs approval'
        : run.status === 'need-args'
          ? 'needs input'
          : 'starting…'}
    </span>
  )
}

function ArgsForm({ run }: { run: ScriptRun }) {
  const submit = useStore((s) => s.submitScriptArgs)
  const [vals, setVals] = useState<Record<string, string>>(() => ({ ...run.args }))
  const first = useRef<HTMLElement | null>(null)
  useEffect(() => first.current?.focus(), [])
  const specs = run.specs.filter(
    (s) => !['clipboard', 'selection'].includes(s.type) || vals[s.name] === undefined,
  )
  return (
    <form
      className="argform"
      onSubmit={(e) => {
        e.preventDefault()
        submit(vals)
      }}
    >
      {run.need?.error && <p className="warn">{run.need.error}</p>}
      {specs.map((s, i) => (
        <label key={s.name}>
          <span>
            {s.prompt ?? s.name}
            {s.optional ? ' (optional)' : ''}
          </span>
          {s.type === 'choice' ? (
            <select
              ref={i === 0 ? (el) => void (first.current = el) : undefined}
              value={vals[s.name] ?? s.default ?? ''}
              onChange={(e) => setVals({ ...vals, [s.name]: e.target.value })}
            >
              <option value="">—</option>
              {s.choices?.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          ) : (
            <input
              ref={i === 0 ? (el) => void (first.current = el) : undefined}
              type={s.type === 'secret' ? 'password' : s.type === 'number' ? 'number' : 'text'}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                s.type === 'file' || s.type === 'folder' ? 'absolute path' : (s.default ?? '')
              }
              value={vals[s.name] ?? ''}
              onChange={(e) => setVals({ ...vals, [s.name]: e.target.value })}
            />
          )}
          {s.type === 'secret' && <small>asked every run; never stored or logged</small>}
        </label>
      ))}
      <div className="hints">
        <kbd>↵</kbd> Run <kbd>Esc</kbd> Cancel
      </div>
    </form>
  )
}

export function ScriptPanel() {
  const run = useStore((s) => s.script) as ScriptRun
  const confirm = useStore((s) => s.confirmScript)
  const endRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView({ block: 'end' })
  }, [run.lines])

  const copyAll = () =>
    void navigator.clipboard.writeText(stripSgr(run.lines.map((l) => l.text).join('')))
  const copyLast = () => {
    const t =
      stripSgr(run.lines.map((l) => l.text).join(''))
        .trimEnd()
        .split('\n')
        .pop() ?? ''
    void navigator.clipboard.writeText(t)
  }

  if (run.status === 'confirm' && run.confirm) {
    const c = run.confirm
    return (
      <div className="spanel" role="alertdialog" aria-label="Approve script">
        <div className="shead">
          <strong>{run.title}</strong>
          <Badge run={run} />
        </div>
        <div className="confirmbody">
          {c.reasons.map((r) => (
            <p key={r} className="warn">
              {r}
            </p>
          ))}
          <dl>
            <dt>File</dt>
            <dd>{c.path}</dd>
            <dt>Interpreter</dt>
            <dd>{c.interpreter}</dd>
          </dl>
          <div className="muted">
            {c.review.kind === 'changed'
              ? 'What changed since you last trusted it:'
              : 'Start of the script:'}
          </div>
          <pre className="review">
            {c.review.text.split('\n').map((l, i) => (
              <div
                key={i}
                className={l.startsWith('+ ') ? 'add' : l.startsWith('- ') ? 'del' : undefined}
              >
                {l || ' '}
              </div>
            ))}
          </pre>
        </div>
        <div className="shint">
          <button onClick={confirm}>
            <kbd>↵</kbd> {c.needsTrust ? 'Trust this version & run' : 'Run'}
          </button>
          <span>
            <kbd>Esc</kbd> Cancel
          </span>
        </div>
      </div>
    )
  }

  if (run.status === 'need-args') {
    return (
      <div className="spanel" aria-label="Script arguments">
        <div className="shead">
          <strong>{run.title}</strong>
          <Badge run={run} />
        </div>
        <ArgsForm run={run} />
      </div>
    )
  }

  return (
    <div className="spanel" aria-label="Script output">
      <div className="shead">
        <strong>{run.title}</strong>
        <Badge run={run} />
      </div>
      {run.progress?.value !== undefined && (
        <div className="bar">
          <div style={{ width: `${Math.round(run.progress.value * 100)}%` }} />
        </div>
      )}
      <div
        className="sbody"
        ref={bodyRef}
        role="log"
        aria-live="polite"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {run.message && <div className="muted">{run.message}</div>}
        {run.lines.map((l, i) => (
          <div key={i} className={'line ' + (l.stream === 'stderr' ? 'stderr' : '')}>
            {renderAnsi(l.text, l.stream === 'stderr' ? 'err' : 'out')}
          </div>
        ))}
        {run.status === 'done' && run.lines.length === 0 && !run.message && (
          <div className="muted">(no output)</div>
        )}
        <div ref={endRef} />
      </div>
      <div className="shint">
        {run.status === 'running' ? (
          <span>
            <kbd>Esc</kbd>/<kbd>{mod()}C</kbd> Cancel
          </span>
        ) : (
          <span>
            <kbd>{mod()}R</kbd> Re-run <kbd>Esc</kbd> Back
          </span>
        )}
        <button onClick={copyAll}>
          Copy all <kbd>{mod()}⇧C</kbd>
        </button>
        <button onClick={copyLast}>Copy last line</button>
      </div>
    </div>
  )
}
