import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { compile, match, prepare } from '@beacon/matcher'
import type { ResultItem } from '@beacon/shared'
import { stripSgr } from './ansi'
import { ScriptPanel } from './ScriptPanel'
import { markCommitted, useStore } from './store'
import { applyTheme } from './theme'

const ROW = 48
const VISIBLE = 8

function hue(s: string): number {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

const iconCache = new Map<string, string | null>()
function Icon({ item }: { item: ResultItem }) {
  const [src, setSrc] = useState<string | null>(
    item.icon ? (iconCache.get(item.icon) ?? null) : null,
  )
  useEffect(() => {
    const p = item.icon
    if (!p || p.startsWith('color:') || (p.length <= 8 && !/[\\/.:]/.test(p))) return
    if (iconCache.has(p)) return setSrc(iconCache.get(p) ?? null)
    void window.beacon.getIcon(p).then((u) => {
      iconCache.set(p, u)
      setSrc(u)
    })
  }, [item.icon])
  if (item.icon && item.icon.length <= 8 && !/[\\/.:]/.test(item.icon))
    return (
      <span className="icon emoji" aria-hidden>
        {item.icon}
      </span>
    )
  if (item.icon?.startsWith('color:'))
    return <span className="icon swatch" style={{ background: item.icon.slice(6) }} aria-hidden />
  if (src) return <img className="icon" src={src} alt="" draggable={false} />
  return (
    <span className="icon letter" style={{ ['--h' as string]: hue(item.title) }} aria-hidden>
      {item.title.slice(0, 1).toUpperCase()}
    </span>
  )
}

function Title({ text, query }: { text: string; query: string }) {
  const parts = useMemo(() => {
    const m = match(prepare(text), compile(query))
    const pos = new Set(m?.positions ?? [])
    return [...text].map((ch, i) => (pos.has(i) ? <mark key={i}>{ch}</mark> : ch))
  }, [text, query])
  return <>{parts}</>
}

export function App() {
  const s = useStore()
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.beacon.getSettings().then(applyTheme)
    const offS = window.beacon.onSettings(applyTheme)
    const offShown = window.beacon.onShown(({ at }) => {
      inputRef.current?.focus()
      inputRef.current?.select()
      // hotkey → first painted frame after show
      requestAnimationFrame(() =>
        requestAnimationFrame(() => window.beacon.reportShown(Date.now())),
      )
      void at
    })
    const offQ = window.beacon.onSetQuery((q) => useStore.getState().setQuery(q))
    s.reset()
    return () => {
      offQ()
      offS()
      offShown()
    }
  }, [])

  const virt = useVirtualizer({
    count: s.items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 4,
  })
  useEffect(() => virt.scrollToIndex(s.selected), [s.selected, virt])
  useLayoutEffect(markCommitted, [s.items])

  const item = s.items[s.selected]
  const actions = item
    ? [{ id: undefined as string | undefined, title: 'Open' }, ...(item.actions ?? [])]
    : []

  /** Run an action, asking first when the action is marked `confirm`. */
  function run(actionId?: string, index?: number) {
    const it = s.items[index ?? s.selected]
    if (!it) return
    const act = actionId
      ? [it.primary, ...(it.actions ?? [])].find((a) => a.id === actionId)
      : it.primary
    const p = (act?.payload ?? {}) as { setQuery?: string; script?: boolean }
    if (act?.id === 'set-query' && p.setQuery !== undefined) return s.setQuery(p.setQuery)
    // Scripts stream into the output panel instead of running headlessly.
    if (act?.id === 'run-script' && p.script) {
      if (act.confirm)
        return s.askConfirm({
          title: act.title,
          index: index ?? s.selected,
          ...(actionId ? { actionId } : {}),
        })
      return s.startScript(it, act.payload as Record<string, unknown>)
    }
    if (act?.confirm)
      s.askConfirm({
        title: act.title,
        index: index ?? s.selected,
        ...(actionId ? { actionId } : {}),
      })
    else s.activate(actionId, index)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const go = (fn: () => void) => {
      e.preventDefault()
      fn()
    }
    const ctrl = e.ctrlKey || e.metaKey
    if (s.script) {
      const sc = s.script
      if (sc.status === 'confirm') {
        if (e.key === 'Enter') go(() => s.confirmScript())
        else if (e.key === 'Escape') go(() => s.closeScript())
      } else if (sc.status === 'need-args') {
        if (e.key === 'Escape') go(() => s.closeScript())
      } else if (sc.status === 'running') {
        if (e.key === 'Escape' || (ctrl && e.key === 'c' && !window.getSelection()?.toString()))
          go(() => s.cancelScript())
      } else if (e.key === 'Escape') go(() => s.closeScript())
      else if (ctrl && e.key === 'r') go(() => s.rerunScript())
      else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'c')
        go(() => void navigator.clipboard.writeText(stripSgr(sc.lines.map((l) => l.text).join(''))))
      return
    }
    if (s.confirm) {
      if (e.key === 'Enter') go(() => s.activate(s.confirm?.actionId, s.confirm?.index))
      else if (e.key === 'Escape') go(() => s.askConfirm(null))
      return
    }
    if (s.actionsOpen) {
      if (e.key === 'ArrowDown') go(() => s.moveAction(1))
      else if (e.key === 'ArrowUp') go(() => s.moveAction(-1))
      else if (e.key === 'Enter') go(() => run(actions[s.actionIndex]?.id))
      else if (e.key === 'Escape' || e.key === 'Tab') go(() => s.toggleActions(false))
      return
    }
    if (e.key === 'ArrowDown') go(() => s.move(1))
    else if (e.key === 'ArrowUp') go(() => s.move(-1))
    else if (e.key === 'Enter') go(() => run())
    else if ((e.key === 'Tab' && !e.shiftKey) || (ctrl && e.key === 'k'))
      go(() => item && s.toggleActions(true))
    else if (ctrl && e.key === 'i') go(() => s.togglePreview())
    else if (ctrl && e.key === 'p') go(() => s.pin())
    else if (ctrl && e.key === 'Backspace') go(() => s.forget())
    else if (ctrl && e.key === ',') go(() => window.beacon.openSettings())
    else if (ctrl && /^[1-9]$/.test(e.key)) go(() => run(undefined, Number(e.key) - 1))
    else if (e.key === 'Escape') {
      e.preventDefault()
      if (s.query) s.reset()
      else window.beacon.hide()
    }
  }

  return (
    <div className="shell" onKeyDown={onKeyDown}>
      <div className="panel">
        <div className="search">
          <svg className="glass-ic" viewBox="0 0 20 20" aria-hidden>
            <circle cx="9" cy="9" r="5.5" />
            <path d="m13.5 13.5 3.5 3.5" />
          </svg>
          <input
            ref={inputRef}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder="Search apps, calculate, or type a command…"
            aria-label="Search"
            role="combobox"
            aria-expanded
            aria-controls="results"
            aria-activedescendant={item ? `r-${s.selected}` : undefined}
            value={s.query}
            readOnly={!!s.script}
            onChange={(e) => s.setQuery(e.target.value)}
          />
        </div>

        {s.script && <ScriptPanel />}
        <div
          className="results"
          hidden={!!s.script}
          ref={scrollRef}
          style={{ maxHeight: ROW * VISIBLE }}
        >
          <div
            id="results"
            role="listbox"
            aria-label="Results"
            style={{ height: virt.getTotalSize(), position: 'relative' }}
          >
            {virt.getVirtualItems().map((v) => {
              const it = s.items[v.index] as ResultItem
              return (
                <div
                  key={`${it.providerId}:${it.id}`}
                  id={`r-${v.index}`}
                  role="option"
                  aria-selected={v.index === s.selected}
                  className={'row' + (v.index === s.selected ? ' sel' : '')}
                  style={{ height: ROW, transform: `translateY(${v.start}px)` }}
                  onMouseMove={() => v.index !== s.selected && s.select(v.index)}
                  onClick={() => run(undefined, v.index)}
                >
                  <Icon item={it} />
                  <span className="text">
                    <span className="title">
                      <Title text={it.title} query={s.query} />
                    </span>
                    {it.subtitle && <span className="sub">{it.subtitle}</span>}
                  </span>
                  <span className="kind">{it.kind}</span>
                  {v.index < 9 && (
                    <kbd className="hint">
                      {navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'}
                      {v.index + 1}
                    </kbd>
                  )}
                </div>
              )
            })}
          </div>
          {!s.items.length && (
            <div className="empty">
              {s.error ??
                (s.query
                  ? s.searching
                    ? 'Searching…'
                    : 'No results'
                  : 'Try “23*1.08”, “uuid”, “g cats”, “timer 5m”, or an app name')}
            </div>
          )}
        </div>
        <div className="sr-only" role="status" aria-live="polite">
          {s.items.length} results
        </div>

        {s.preview && item && (
          <pre className="preview" aria-label="Preview">
            {item.preview?.value ?? `${item.title}\n${item.subtitle ?? ''}`}
          </pre>
        )}

        {s.actionsOpen && item && (
          <div className="actions" role="menu" aria-label="Actions">
            {actions.map((a, i) => (
              <div
                key={a.id ?? 'primary'}
                role="menuitem"
                className={'act' + (i === s.actionIndex ? ' sel' : '')}
                onClick={() => run(a.id)}
              >
                {a.title}
              </div>
            ))}
          </div>
        )}

        {s.confirm && (
          <div className="confirm" role="alertdialog" aria-label="Confirm">
            <span>{s.confirm.title}?</span>
            <span>
              <kbd>↵</kbd> Confirm <kbd>Esc</kbd> Cancel
            </span>
          </div>
        )}

        {s.toast && (
          <div className="toast" role="status">
            {s.toast}
          </div>
        )}

        <footer className="footer" hidden={!!s.script}>
          <span>
            <kbd>↵</kbd> Open
          </span>
          <span>
            <kbd>Tab</kbd> Actions
          </span>
          <span>
            <kbd>{navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'}P</kbd> Pin
          </span>
          <span>
            <kbd>{navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'}I</kbd> Preview
          </span>
          <span>
            <kbd>Esc</kbd> {s.query ? 'Clear' : 'Close'}
          </span>
        </footer>
      </div>
    </div>
  )
}
