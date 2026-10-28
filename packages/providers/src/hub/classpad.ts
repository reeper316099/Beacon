import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { copyAction } from '../base'
import { deepLink, type HubItem, type LoadResult, type SourceAdapter } from './types'
import { frontmatter, listFiles, readJson, str, unwrapItems } from './util'

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const open = (type: string, id: string) => ({
  id: 'open',
  title: 'Open in Classpad',
  kind: 'deeplink' as const,
  payload: { url: deepLink('classpad', 'open', { type, id }) },
})

/**
 * Classpad (read-only): today's deadlines, upcoming assignments, tasks, note titles.
 * Grades are never read: only id/title/classId/status/due are copied out of each assignment, so scores,
 * weights, points and grading schemes cannot appear in results, previews or logs. (Classpad's "hide
 * grades" switch lives in app UI state and is not detectable on disk, so grades are simply always out.)
 * Encrypted collections are skipped.
 */
export const classpad: SourceAdapter = {
  contractVersion: 1,
  id: 'classpad',
  name: 'Classpad',
  scheme: 'classpad',
  triggers: ['cp ', 'class '],
  dataDirEnv: 'CLASSPAD_DATA_DIR',
  folderName: 'Classpad',

  async load(dir, opts): Promise<LoadResult> {
    const items: HubItem[] = []
    const warnings: string[] = []
    const today = ymd(opts.now)
    const horizon = ymd(
      new Date(opts.now.getFullYear(), opts.now.getMonth(), opts.now.getDate() + 21),
    )

    const classNames = new Map<string, string>()
    for (const file of await listFiles(join(dir, 'data/classes'), '.json')) {
      const r = await readJson(file)
      if (!r.ok) {
        if (r.reason === 'encrypted') warnings.push('classes are encrypted; skipped')
        continue
      }
      for (const c of unwrapItems(r.value).items as Record<string, unknown>[]) {
        const id = str(c?.['id'])
        const name = str(c?.['code']) ?? str(c?.['name'])
        if (id && name) classNames.set(id, name)
      }
    }

    for (const file of await listFiles(join(dir, 'data/assignments'), '.json')) {
      const r = await readJson(file)
      if (!r.ok) {
        warnings.push(`skipped an assignments file (${r.reason})`)
        continue
      }
      for (const a of unwrapItems(r.value).items as Record<string, unknown>[]) {
        const id = str(a?.['id'])
        const title = str(a?.['title'])
        if (!id || !title) continue
        const due = str(a?.['due'])?.slice(0, 10)
        const status = str(a?.['status'])
        if (status === 'complete') continue
        // Pull out ONLY these fields; everything else (score, weight, points...) is dropped here.
        const cls = classNames.get(str(a?.['classId']) ?? '')
        const overdue = due !== undefined && due < today
        const isToday = due === today
        if (due && due > horizon) continue
        items.push({
          id: `cp:a:${id}`,
          title,
          subtitle: [
            cls,
            due
              ? overdue
                ? `overdue · ${due}`
                : isToday
                  ? 'due today'
                  : `due ${due}`
              : 'no due date',
          ]
            .filter(Boolean)
            .join(' · '),
          kind: 'assignment',
          keywords: cls ? [cls] : [],
          primary: open('assignment', id),
          actions: [copyAction(title, 'Copy title')],
          today: overdue || isToday,
          boost: overdue || isToday ? 2 : 0,
        })
      }
    }

    const tasks = await readJson(join(dir, 'data/tasks/tasks.json'))
    if (tasks.ok) {
      for (const t of unwrapItems(tasks.value).items as Record<string, unknown>[]) {
        const id = str(t?.['id'])
        const title = str(t?.['title'])
        if (!id || !title || t?.['done'] === true) continue
        const date = str(t?.['date'])?.slice(0, 10)
        if (date && date > horizon) continue
        const isToday = date !== undefined && date <= today
        items.push({
          id: `cp:t:${id}`,
          title,
          subtitle: [
            'Task',
            date ? (isToday ? (date === today ? 'today' : `overdue · ${date}`) : date) : undefined,
          ]
            .filter(Boolean)
            .join(' · '),
          kind: 'task',
          primary: open('task', id),
          actions: [copyAction(title, 'Copy title')],
          today: isToday,
        })
      }
    } else if (tasks.reason === 'encrypted') warnings.push('tasks are encrypted; skipped')

    // Notes: title only (never the body).
    for (const file of await listFiles(join(dir, 'data/notes'), '.md')) {
      let text: string
      try {
        text = await fs.readFile(file, 'utf8')
      } catch {
        continue
      }
      const fm = frontmatter(text)
      const id = str(fm?.data['id'])
      const title = str(fm?.data['title'])
      if (!id || !title) continue
      const cls = classNames.get(str(fm?.data['classId']) ?? '')
      items.push({
        id: `cp:n:${id}`,
        title,
        subtitle: ['Note', cls].filter(Boolean).join(' · '),
        kind: 'note',
        primary: open('note', id),
      })
    }
    return { items, warnings }
  },
}
