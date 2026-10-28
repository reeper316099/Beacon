import { create } from 'zustand'
import { StableList, type ClientMessage, type ServerMessage } from '@beacon/core'
import type { ResultItem } from '@beacon/shared'
import type { BeaconSettings } from './global'

export interface ScriptSpec {
  name: string
  type: string
  choices?: string[]
  optional: boolean
  default?: string
  prompt?: string
}
export interface ScriptRun {
  runId: string
  scriptId: string
  title: string
  status: 'starting' | 'confirm' | 'need-args' | 'running' | 'done' | 'error'
  lines: { stream: 'stdout' | 'stderr'; text: string }[]
  args: Record<string, string>
  specs: ScriptSpec[]
  trustHash?: string
  confirm?: {
    path: string
    interpreter: string
    reasons: string[]
    review: { kind: string; text: string }
    needsTrust: boolean
  }
  need?: { error?: string }
  exit?: {
    exitCode: number | null
    signal: string | null
    durationMs: number
    truncated: boolean
    timedOut: boolean
    cancelled: boolean
    error?: string
  }
  progress?: { value?: number; label?: string }
  message?: string
}

let port: MessagePort | null = null
let qid = 0
let activeQuery = 0
/** Query text at the time each activation was sent, so a late reply can't wipe a newer query. */
const activations = new Map<number, string>()
let keyAt = 0
let reported = false
const list = new StableList()
const pending: ClientMessage[] = []

interface State {
  query: string
  items: ResultItem[]
  selected: number
  actionsOpen: boolean
  actionIndex: number
  confirm: { title: string; actionId?: string; index: number } | null
  askConfirm(c: State['confirm']): void
  toast: string | null
  script: ScriptRun | null
  startScript(item: ResultItem, payload?: Record<string, unknown>): void
  submitScriptArgs(values: Record<string, string>): void
  confirmScript(): void
  cancelScript(): void
  closeScript(): void
  rerunScript(): void
  preview: boolean
  togglePreview(): void
  pin(): void
  forget(): void
  settings: BeaconSettings | null
  searching: boolean
  error: string | null
  setQuery(q: string): void
  move(delta: number): void
  select(i: number): void
  toggleActions(open?: boolean): void
  moveAction(delta: number): void
  activate(actionId?: string, index?: number): void
  reset(): void
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
function flash(msg: string): void {
  useStore.setState({ toast: msg })
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => useStore.setState({ toast: null }), 1800)
}

function post(m: ClientMessage): void {
  if (port) port.postMessage(m)
  else pending.push(m)
}

export const useStore = create<State>((set, get) => ({
  query: '',
  items: [],
  selected: 0,
  actionsOpen: false,
  actionIndex: 0,
  confirm: null,
  toast: null,
  script: null,
  preview: false,
  togglePreview: () => set((s) => ({ preview: !s.preview })),
  askConfirm: (c) => set({ confirm: c }),
  settings: null,
  searching: false,
  error: null,

  setQuery(q) {
    keyAt = performance.now()
    reported = false
    list.clear()
    activeQuery = ++qid
    set({ query: q, items: [], selected: 0, actionsOpen: false, searching: true, error: null })
    post({ type: 'query', id: activeQuery, text: q })
  },
  move(delta) {
    const n = get().items.length
    if (n) set({ selected: (get().selected + delta + n) % n })
  },
  select: (i) => set({ selected: i }),
  toggleActions(open) {
    set((s) => ({ actionsOpen: open ?? !s.actionsOpen, actionIndex: 0 }))
  },
  moveAction(delta) {
    const item = get().items[get().selected]
    const n = 1 + (item?.actions?.length ?? 0)
    set({ actionIndex: (get().actionIndex + delta + n) % n })
  },
  activate(actionId, index) {
    const s = get()
    const item = s.items[index ?? s.selected]
    if (!item) return
    set({ confirm: null, actionsOpen: false })
    const aid = ++qid
    activations.set(aid, s.query)
    post({
      type: 'activate',
      id: aid,
      providerId: item.providerId,
      itemId: item.id,
      query: s.query,
      ...(actionId ? { actionId } : {}),
      ...(item.frecencyKey ? { frecencyKey: item.frecencyKey } : {}),
    })
  },
  pin() {
    const it = get().items[get().selected]
    if (it) post({ type: 'pin', id: ++qid, item: it })
  },
  forget() {
    const s = get()
    const it = s.items[s.selected]
    if (!it) return
    post({
      type: 'forget',
      id: ++qid,
      providerId: it.providerId,
      itemId: it.id,
      ...(it.frecencyKey ? { frecencyKey: it.frecencyKey } : {}),
    })
    list.items = list.items.filter((x) => x !== it)
    set({ items: list.items, selected: Math.min(s.selected, Math.max(0, list.items.length - 1)) })
    flash('Removed from history')
  },
  startScript(it, payload) {
    const p = (payload ?? (it.primary.payload as Record<string, unknown>)) as {
      scriptId: string
      args?: Record<string, string>
      specs?: ScriptSpec[]
    }
    const runId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const args = { ...(p.args ?? {}) }
    set({
      script: {
        runId,
        scriptId: p.scriptId,
        title: it.title,
        status: 'starting',
        lines: [],
        args,
        specs: p.specs ?? [],
      },
      actionsOpen: false,
    })
    post({ type: 'script-run', runId, scriptId: p.scriptId, args })
  },
  submitScriptArgs(values) {
    const sc = get().script
    if (!sc) return
    const args = { ...sc.args, ...values }
    set({ script: { ...sc, args, status: 'starting', need: undefined as never } })
    post({
      type: 'script-run',
      runId: sc.runId,
      scriptId: sc.scriptId,
      args,
      ...(sc.trustHash ? { trustHash: sc.trustHash, confirmed: true } : {}),
    })
  },
  confirmScript() {
    const sc = get().script
    if (!sc?.trustHash) return
    set({ script: { ...sc, status: 'starting' } })
    post({
      type: 'script-run',
      runId: sc.runId,
      scriptId: sc.scriptId,
      args: sc.args,
      trustHash: sc.trustHash,
      confirmed: true,
    })
  },
  cancelScript() {
    const sc = get().script
    if (sc) post({ type: 'script-cancel', runId: sc.runId })
  },
  closeScript() {
    const sc = get().script
    if (sc?.status === 'running') post({ type: 'script-cancel', runId: sc.runId })
    set({ script: null })
    flushLines.length = 0
  },
  rerunScript() {
    const sc = get().script
    if (!sc) return
    // Secrets were never stored: the worker asks for them again.
    const args = Object.fromEntries(
      Object.entries(sc.args).filter(
        ([k]) => sc.specs.find((x) => x.name === k)?.type !== 'secret',
      ),
    )
    const runId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    set({
      script: {
        ...sc,
        runId,
        args,
        status: 'starting',
        lines: [],
        exit: undefined as never,
        progress: undefined as never,
        message: undefined as never,
      },
    })
    post({ type: 'script-run', runId, scriptId: sc.scriptId, args })
  },
  reset() {
    get().setQuery('')
  },
}))

// Output arrives in bursts; coalesce into one state update per frame.
const flushLines: { stream: 'stdout' | 'stderr'; text: string }[] = []
let flushScheduled = false
const MAX_LINES = 4000
function scheduleFlush(): void {
  if (flushScheduled) return
  flushScheduled = true
  requestAnimationFrame(() => {
    flushScheduled = false
    const sc = useStore.getState().script
    if (!sc || !flushLines.length) return
    const merged = [...sc.lines]
    for (const c of flushLines.splice(0)) {
      const prev = merged[merged.length - 1]
      if (prev && prev.stream === c.stream && !prev.text.endsWith('\n'))
        merged[merged.length - 1] = { stream: prev.stream, text: prev.text + c.text }
      else merged.push(c)
    }
    useStore.setState({
      script: { ...sc, lines: merged.length > MAX_LINES ? merged.slice(-MAX_LINES) : merged },
    })
  })
}

function onScriptEvent(runId: string, ev: Record<string, unknown>): void {
  const sc = useStore.getState().script
  if (!sc || sc.runId !== runId) return
  const set = (patch: Partial<ScriptRun>) =>
    useStore.setState({ script: { ...useStore.getState().script!, ...patch } })
  switch (ev['ev']) {
    case 'confirm':
      return set({
        status: 'confirm',
        trustHash: String(ev['hash']),
        confirm: {
          path: String(ev['path']),
          interpreter: String(ev['interpreter']),
          reasons: ev['reasons'] as string[],
          review: ev['review'] as never,
          needsTrust: !!ev['needsTrust'],
        },
      })
    case 'need-args':
      return set({
        status: 'need-args',
        specs: ev['specs'] as ScriptSpec[],
        args: { ...sc.args, ...(ev['values'] as Record<string, string>) },
        need: ev['error'] ? { error: String(ev['error']) } : {},
      })
    case 'start':
      return set({ status: 'running', lines: [] })
    case 'out':
      flushLines.push({ stream: ev['stream'] as 'stdout' | 'stderr', text: String(ev['text']) })
      return scheduleFlush()
    case 'progress':
      return set({
        progress: {
          ...(typeof ev['value'] === 'number' ? { value: ev['value'] } : {}),
          ...(typeof ev['label'] === 'string' ? { label: ev['label'] } : {}),
        },
      })
    case 'toast':
      return set({ message: String(ev['message']) })
    case 'error':
      return set({ status: 'error', message: String(ev['message']) })
    case 'exit': {
      // Make sure buffered output lands before the status flips.
      const pending = flushLines.splice(0)
      const lines = [...sc.lines]
      for (const c of pending) lines.push(c)
      return set({ status: 'done', lines, exit: ev as never })
    }
  }
}

function onMessage(m: ServerMessage): void {
  const s = useStore.getState()
  if (m.type === 'script-event') return onScriptEvent(m.runId, m.event)
  if (m.type === 'batch' && m.id === activeQuery) {
    list.merge(m.items, s.items.length ? s.selected : -1)
    useStore.setState({ items: list.items })
    if (!reported && m.items.length) reported = true // reported from App's layout effect
  } else if (m.type === 'done' && m.id === activeQuery) {
    useStore.setState({ searching: false })
  } else if (m.type === 'pinned') {
    flash(m.pinned ? 'Pinned' : 'Unpinned (or not pinnable)')
  } else if (m.type === 'activated') {
    const sentFor = activations.get(m.id)
    activations.delete(m.id)
    if (m.ok) {
      // If the user has already summoned Beacon again and typed something else, leave it alone.
      if (sentFor === undefined || sentFor === useStore.getState().query) {
        window.beacon.hide()
        useStore.getState().reset()
      }
    } else useStore.setState({ error: m.error ?? 'Action failed' })
  }
}

/** Called after React commits results to the DOM: keystroke → commit, then → next painted frame. */
let committedFor = 0
export function markCommitted(): void {
  if (!reported || committedFor === activeQuery) return
  committedFor = activeQuery
  const commit = performance.now() - keyAt
  requestAnimationFrame(() => window.beacon.reportKeystroke(commit, performance.now() - keyAt))
}

export function initPort(): void {
  window.addEventListener('message', (e) => {
    if (e.data !== 'beacon-port' || !e.ports[0]) return
    port?.close()
    port = e.ports[0]
    port.onmessage = (ev) => onMessage(ev.data as ServerMessage)
    for (const m of pending.splice(0)) port.postMessage(m)
    // Re-issue the current query (e.g. after a renderer reload).
    useStore.getState().setQuery(useStore.getState().query)
  })
}
