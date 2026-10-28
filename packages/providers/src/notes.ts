import type { Action, ParsedQuery, ProviderContext, ResultItem } from '@beacon/shared'
import type { JsonFile } from '@beacon/jsonstore'
import { LiveProvider, item } from './base'

export interface Note {
  id: string
  text: string
  ts: number
}
export interface Todo {
  id: string
  text: string
  done: boolean
  /** Local date YYYY-MM-DD */
  due?: string
  ts: number
}

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Pull `due:today|tomorrow|YYYY-MM-DD` (or `!date`) out of a todo line. */
export function parseTodo(line: string, now: Date): { text: string; due?: string } {
  let due: string | undefined
  const text = line
    .replace(/(?:^|\s)(?:due:|!)(today|tomorrow|\d{4}-\d{2}-\d{2})(?=\s|$)/i, (_m, v: string) => {
      const l = v.toLowerCase()
      if (l === 'today') due = ymd(now)
      else if (l === 'tomorrow')
        due = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))
      else due = l
      return ''
    })
    .trim()
  return due ? { text, due } : { text }
}

const nid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

export function dueToday(todos: Todo[], now: Date): Todo[] {
  const t = ymd(now)
  return todos.filter((x) => !x.done && x.due !== undefined && x.due <= t)
}

export class NotesProvider extends LiveProvider {
  id = 'notes'
  name = 'Quick notes'
  mode = 'prefix-only' as const
  triggers = ['note ', 'note']
  constructor(private file: JsonFile<Note[]>) {
    super()
  }
  protected compute(q: ParsedQuery): ResultItem[] {
    const text = q.raw.slice((q.trigger ?? '').length).trim()
    const out: ResultItem[] = []
    if (text)
      out.push(
        item(this.id, {
          id: 'add:' + text,
          title: `Save note: ${text}`,
          kind: 'note',
          score: 900,
          primary: { id: 'add', title: 'Save note', kind: 'custom', payload: { text } },
        }),
      )
    const needle = text.toLowerCase()
    for (const n of [...this.file.data]
      .reverse()
      .filter((n) => !needle || n.text.toLowerCase().includes(needle))
      .slice(0, 25))
      out.push(
        item(this.id, {
          id: n.id,
          title: n.text.split('\n')[0] as string,
          kind: 'note',
          score: 400,
          subtitle: new Date(n.ts).toLocaleString(),
          primary: { id: 'copy', title: 'Copy note', kind: 'copy', payload: { text: n.text } },
          actions: [
            {
              id: 'delete',
              title: 'Delete note',
              kind: 'custom',
              confirm: true,
              payload: { id: n.id },
            },
          ],
        }),
      )
    return out
  }
  protected async custom(a: Action, _it: ResultItem, ctx: ProviderContext): Promise<void> {
    const p = a.payload as { text?: string; id?: string }
    if (a.id === 'add' && p.text)
      await this.file.update((d) => [...d, { id: nid(), text: p.text as string, ts: ctx.now() }])
    else if (a.id === 'delete') await this.file.update((d) => d.filter((n) => n.id !== p.id))
  }
}

export class TodoProvider extends LiveProvider {
  id = 'todos'
  name = 'Todos'
  // Global so that today's due todos can surface in the empty state; text queries need the trigger.
  mode = 'global' as const
  triggers = ['todo ', 'todo']
  constructor(readonly file: JsonFile<Todo[]>) {
    super()
  }
  protected compute(q: ParsedQuery, ctx: ProviderContext): ResultItem[] {
    if (!q.trigger && q.text) return []
    const line = q.raw.slice((q.trigger ?? '').length).trim()
    const out: ResultItem[] = []
    if (!q.trigger) {
      return dueToday(this.file.data, new Date(ctx.now())).map((t) =>
        item(this.id, {
          id: t.id,
          title: '○ ' + t.text,
          subtitle: `Due ${t.due}`,
          kind: 'todo',
          score: 900,
          primary: { id: 'toggle', title: 'Mark done', kind: 'custom', payload: { id: t.id } },
        }),
      )
    }
    if (line) {
      const t = parseTodo(line, new Date(ctx.now()))
      out.push(
        item(this.id, {
          id: 'add:' + line,
          title: `Add todo: ${t.text}`,
          ...(t.due ? { subtitle: `due ${t.due}` } : {}),
          kind: 'todo',
          score: 900,
          primary: { id: 'add', title: 'Add todo', kind: 'custom', payload: t },
        }),
      )
    }
    const needle = line.toLowerCase()
    const list = this.file.data.filter((t) => !needle || t.text.toLowerCase().includes(needle))
    list.sort(
      (a, b) =>
        Number(a.done) - Number(b.done) ||
        (a.due ?? '9').localeCompare(b.due ?? '9') ||
        a.ts - b.ts,
    )
    for (const t of list.slice(0, 30))
      out.push(
        item(this.id, {
          id: t.id,
          title: (t.done ? '✓ ' : '○ ') + t.text,
          kind: 'todo',
          score: t.done ? 200 : 400,
          ...(t.due ? { subtitle: `due ${t.due}` } : {}),
          primary: {
            id: 'toggle',
            title: t.done ? 'Mark not done' : 'Mark done',
            kind: 'custom',
            payload: { id: t.id },
          },
          actions: [
            {
              id: 'delete',
              title: 'Delete todo',
              kind: 'custom',
              confirm: true,
              payload: { id: t.id },
            },
          ],
        }),
      )
    return out
  }
  protected async custom(a: Action, _it: ResultItem, ctx: ProviderContext): Promise<void> {
    const p = a.payload as { text?: string; due?: string; id?: string }
    if (a.id === 'add' && p.text)
      await this.file.update((d) => [
        ...d,
        {
          id: nid(),
          text: p.text as string,
          done: false,
          ts: ctx.now(),
          ...(p.due ? { due: p.due } : {}),
        },
      ])
    else if (a.id === 'toggle')
      await this.file.update((d) => d.map((t) => (t.id === p.id ? { ...t, done: !t.done } : t)))
    else if (a.id === 'delete') await this.file.update((d) => d.filter((t) => t.id !== p.id))
  }
}
