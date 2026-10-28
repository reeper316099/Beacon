import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { compile, match, prepare } from '@beacon/matcher'
import type { ResultItem } from '@beacon/shared'
import { useStore } from './store'
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
    if (!p) return
    if (iconCache.has(p)) return setSrc(iconCache.get(p) ?? null)
    void window.beacon.getIcon(p).then((u) => {
      iconCache.set(p, u)
      setSrc(u)
    })
  }, [item.icon])
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
    s.reset()
    return () => {
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

  const item = s.items[s.selected]
  const actions = item
    ? [{ id: undefined as string | undefined, title: 'Open' }, ...(item.actions ?? [])]
    : []

  function onKeyDown(e: React.KeyboardEvent) {
    const go = (fn: () => void) => {
      e.preventDefault()
      fn()
    }
    const ctrl = e.ctrlKey || e.metaKey
    if (s.actionsOpen) {
      if (e.key === 'ArrowDown') go(() => s.moveAction(1))
      else if (e.key === 'ArrowUp') go(() => s.moveAction(-1))
      else if (e.key === 'Enter') go(() => s.activate(actions[s.actionIndex]?.id))
      else if (e.key === 'Escape' || e.key === 'Tab') go(() => s.toggleActions(false))
      return
    }
    if (e.key === 'ArrowDown' || (ctrl && e.key === 'n')) go(() => s.move(1))
    else if (e.key === 'ArrowUp' || (ctrl && e.key === 'p')) go(() => s.move(-1))
    else if (e.key === 'Enter') go(() => s.activate())
    else if ((e.key === 'Tab' && !e.shiftKey) || (ctrl && e.key === 'k'))
      go(() => item && s.toggleActions(true))
    else if (ctrl && e.key === ',') go(() => window.beacon.openSettings())
    else if (ctrl && /^[1-9]$/.test(e.key)) go(() => s.activate(undefined, Number(e.key) - 1))
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
            placeholder="Search apps…"
            aria-label="Search"
            role="combobox"
            aria-expanded
            aria-controls="results"
            aria-activedescendant={item ? `r-${s.selected}` : undefined}
            value={s.query}
            onChange={(e) => s.setQuery(e.target.value)}
          />
        </div>

        <div className="results" ref={scrollRef} style={{ maxHeight: ROW * VISIBLE }}>
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
                  onClick={() => s.activate(undefined, v.index)}
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
                (s.query ? (s.searching ? 'Searching…' : 'No results') : 'Type to search apps')}
            </div>
          )}
        </div>
        <div className="sr-only" role="status" aria-live="polite">
          {s.items.length} results
        </div>

        {s.actionsOpen && item && (
          <div className="actions" role="menu" aria-label="Actions">
            {actions.map((a, i) => (
              <div
                key={a.id ?? 'primary'}
                role="menuitem"
                className={'act' + (i === s.actionIndex ? ' sel' : '')}
                onClick={() => s.activate(a.id)}
              >
                {a.title}
              </div>
            ))}
          </div>
        )}

        <footer className="footer">
          <span>
            <kbd>↵</kbd> Open
          </span>
          <span>
            <kbd>Tab</kbd> Actions
          </span>
          <span>
            <kbd>Esc</kbd> {s.query ? 'Clear' : 'Close'}
          </span>
        </footer>
      </div>
    </div>
  )
}
