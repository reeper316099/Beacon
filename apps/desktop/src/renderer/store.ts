import { create } from 'zustand'
import { StableList, type ClientMessage, type ServerMessage } from '@beacon/core'
import type { ResultItem } from '@beacon/shared'
import type { BeaconSettings } from './global'

let port: MessagePort | null = null
let qid = 0
let activeQuery = 0
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
    post({
      type: 'activate',
      id: ++qid,
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
  reset() {
    get().setQuery('')
  },
}))

function onMessage(m: ServerMessage): void {
  const s = useStore.getState()
  if (m.type === 'batch' && m.id === activeQuery) {
    list.merge(m.items, s.items.length ? s.selected : -1)
    useStore.setState({ items: list.items })
    if (!reported && m.items.length) reported = true // reported from App's layout effect
  } else if (m.type === 'done' && m.id === activeQuery) {
    useStore.setState({ searching: false })
  } else if (m.type === 'pinned') {
    flash(m.pinned ? 'Pinned' : 'Unpinned (or not pinnable)')
  } else if (m.type === 'activated') {
    if (m.ok) {
      window.beacon.hide()
      useStore.getState().reset()
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
