import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { FuzzyIndex } from '@beacon/matcher'
import type { JsonFile } from '@beacon/jsonstore'
import type { Action, ParsedQuery, ProviderContext, ResultItem } from '@beacon/shared'
import { LiveProvider, copyAction, item } from '../base'
import {
  assignTyped,
  type ListLine,
  type ScriptEntry,
  type ScriptManager,
  type ScriptsConfig,
} from './manager'

const TEMPLATES: Record<string, { ext: string; body: (name: string) => string }> = {
  python: {
    ext: '.py',
    body: (n) =>
      `#!/usr/bin/env python3\n# @beacon.title    ${n}\n# @beacon.desc     Describe what this does\n# @beacon.keyword  ${n.toLowerCase().replace(/\\W+/g, '')}\n# @beacon.output   inline\n# @beacon.timeout  30\n\nimport sys\n\nprint("Hello from ${n}", sys.argv[1:])\n`,
  },
  node: {
    ext: '.js',
    body: (n) =>
      `#!/usr/bin/env node\n// @beacon.title    ${n}\n// @beacon.desc     Describe what this does\n// @beacon.keyword  ${n.toLowerCase().replace(/\\W+/g, '')}\n// @beacon.output   inline\n// @beacon.timeout  30\n\nconsole.log('Hello from ${n}', process.argv.slice(2))\n`,
  },
  bash: {
    ext: '.sh',
    body: (n) =>
      `#!/usr/bin/env bash\n# @beacon.title    ${n}\n# @beacon.desc     Describe what this does\n# @beacon.keyword  ${n.toLowerCase().replace(/\\W+/g, '')}\n# @beacon.output   inline\n# @beacon.timeout  30\nset -euo pipefail\n\necho "Hello from ${n}: $*"\n`,
  },
  powershell: {
    ext: '.ps1',
    body: (n) =>
      `# @beacon.title    ${n}\n# @beacon.desc     Describe what this does\n# @beacon.keyword  ${n.toLowerCase().replace(/\\W+/g, '')}\n# @beacon.output   inline\n# @beacon.timeout  30\n\nWrite-Output "Hello from ${n}: $args"\n`,
  },
}
const LANG_ALIASES: Record<string, string> = {
  py: 'python',
  python: 'python',
  js: 'node',
  node: 'node',
  sh: 'bash',
  bash: 'bash',
  ps1: 'powershell',
  powershell: 'powershell',
  pwsh: 'powershell',
}

export class ScriptsProvider extends LiveProvider {
  id = 'scripts'
  name = 'Scripts'
  weight = 0.9
  triggers = ['script ', 'scripts ']
  /** List-mode scripts can take a moment; they never delay other providers. */
  timeoutMs = 5000
  constructor(
    private manager: ScriptManager,
    private entries: () => ScriptEntry[],
    private cfgFile: JsonFile<ScriptsConfig>,
    private defaultDir: string,
    private reloadScripts: () => Promise<void>,
  ) {
    super()
  }

  private runItem(e: ScriptEntry, args: Record<string, string>, score: number): ResultItem {
    const needs = e.meta.args.filter(
      (a) =>
        !a.optional && args[a.name] === undefined && !['clipboard', 'selection'].includes(a.type),
    )
    const mode = e.meta.output
    if (mode === 'list')
      return item(this.id, {
        id: e.id,
        title: e.title,
        kind: 'script',
        score,
        icon: e.meta.icon ?? '',
        subtitle: [
          e.group,
          e.meta.desc ?? 'Type here to filter',
          e.meta.keyword ? `keyword: ${e.meta.keyword}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
        primary: {
          id: 'set-query',
          title: 'Filter with this script',
          kind: 'custom',
          payload: { setQuery: (e.meta.keyword ?? e.title) + ' ' },
        },
      })
    return item(this.id, {
      id: e.id,
      title: e.title,
      kind: 'script',
      score,
      icon: e.meta.icon ?? '',
      subtitle: [
        e.group,
        e.meta.desc,
        needs.length ? `needs ${needs.map((n) => n.name).join(', ')}` : '',
        e.meta.keyword ? `keyword: ${e.meta.keyword}` : '',
        mode !== 'inline' ? mode : '',
      ]
        .filter(Boolean)
        .join(' · '),
      primary: {
        id: 'run-script',
        title: 'Run',
        kind: 'custom',
        payload: { script: true, scriptId: e.id, args, specs: e.meta.args, mode },
      },
      actions: [
        { id: 'reveal', title: 'Reveal script file', kind: 'reveal', payload: { path: e.path } },
        { id: 'open', title: 'Open script in editor', kind: 'open', payload: { path: e.path } },
        copyAction(e.path, 'Copy path'),
      ],
    })
  }

  protected async compute(
    q: ParsedQuery,
    _ctx: ProviderContext,
    signal: AbortSignal,
  ): Promise<ResultItem[]> {
    const entries = this.entries()
    const out: ResultItem[] = []

    if (q.trigger) {
      const [cmd, ...rest] = q.terms
      if (cmd === 'new') {
        const lang = LANG_ALIASES[(rest[0] ?? '').toLowerCase()]
        const name = rest.slice(1).join(' ').trim()
        const langs = lang ? [lang] : Object.keys(TEMPLATES)
        return langs.map((l, i) =>
          item(this.id, {
            id: `new:${l}:${name}`,
            kind: 'script',
            score: 900 - i,
            title: name ? `Create ${l} script “${name}”` : `New ${l} script…`,
            subtitle: name
              ? `in ${this.cfgFile.data.folders[0]?.path ?? this.defaultDir}`
              : `type: script new ${l === 'python' ? 'py' : l} <name>`,
            primary: {
              id: 'create',
              title: 'Create script',
              kind: 'custom',
              payload: { lang: l, name },
            },
          }),
        )
      }
      if (cmd === 'add' && rest[0]) {
        const path = q.raw.slice(q.raw.toLowerCase().indexOf('add') + 3).trim()
        return [
          item(this.id, {
            id: 'add:' + path,
            title: `Add script folder`,
            subtitle: path,
            kind: 'script',
            score: 900,
            primary: { id: 'add-folder', title: 'Add folder', kind: 'custom', payload: { path } },
          }),
        ]
      }
      if (cmd === 'reload')
        return [
          item(this.id, {
            id: 'reload',
            title: 'Reload scripts',
            kind: 'script',
            score: 900,
            primary: { id: 'reload', title: 'Reload', kind: 'custom', payload: null },
          }),
        ]
      const text = q.text
      const hits = text
        ? new FuzzyIndex(
            entries.map(
              (e) =>
                [[e.title, e.meta.keyword ?? '', e.meta.desc ?? '', e.group].join(' '), e] as const,
            ),
          )
            .search(text, 40)
            .map((r) => r.item)
        : entries.slice(0, 40)
      for (const [i, e] of hits.entries()) out.push(this.runItem(e, {}, 600 - i))
      out.push(
        item(this.id, {
          id: 'new',
          title: 'New script…',
          subtitle: 'script new py|js|sh|ps1 <name>',
          kind: 'script',
          score: 10,
          primary: {
            id: 'set-query',
            title: 'Start',
            kind: 'custom',
            payload: { setQuery: 'script new ' },
          },
        }),
      )
      return out
    }

    const [first = '', ...rest] = q.terms
    const byKeyword = entries.find(
      (e) => e.meta.keyword && e.meta.keyword.toLowerCase() === first.toLowerCase(),
    )
    if (byKeyword) {
      if (byKeyword.meta.output === 'list') {
        const text = rest.join(' ')
        await new Promise((r) => setTimeout(r, 150)) // debounce: a newer keystroke aborts before we spawn
        if (signal.aborted) return []
        const res = await this.manager.runList(byKeyword, text, signal)
        if (res.needsTrust)
          return [
            item(this.id, {
              id: byKeyword.id,
              title: `Review & trust “${byKeyword.title}”`,
              subtitle: 'List-mode scripts run only after you trust them',
              kind: 'script',
              score: 900,
              primary: {
                id: 'run-script',
                title: 'Review',
                kind: 'custom',
                payload: {
                  script: true,
                  scriptId: byKeyword.id,
                  args: {},
                  specs: [],
                  mode: 'list-trust',
                },
              },
            }),
          ]
        if (res.error)
          return [
            item(this.id, {
              id: 'err',
              title: res.error,
              kind: 'script',
              score: 50,
              primary: copyAction(res.error, 'Copy error'),
            }),
          ]
        return res.items.map((l, i) => this.listItem(byKeyword, l, i))
      }
      out.push(this.runItem(byKeyword, assignTyped(byKeyword.meta.args, rest), 950))
    }
    if (q.text.length >= 2) {
      const hits = new FuzzyIndex(
        entries.map(
          (e) => [[e.title, e.meta.keyword ?? '', e.meta.desc ?? ''].join(' '), e] as const,
        ),
      ).search(q.text, 8)
      for (const h of hits) if (h.item !== byKeyword) out.push(this.runItem(h.item, {}, h.score))
    }
    return out
  }

  private listItem(e: ScriptEntry, l: ListLine, i: number): ResultItem {
    const v = l.value ?? l.title
    const a = l.action ?? 'copy'
    let primary: Action
    if (a === 'open') primary = { id: 'open', title: 'Open', kind: 'open', payload: { path: v } }
    else if (a === 'url')
      primary = { id: 'url', title: 'Open URL', kind: 'url', payload: { url: v } }
    else if (a.startsWith('run:')) {
      const target = this.entries().find(
        (x) => x.meta.keyword === a.slice(4) || x.title.toLowerCase() === a.slice(4).toLowerCase(),
      )
      primary = target
        ? {
            id: 'run-script',
            title: `Run ${target.title}`,
            kind: 'custom',
            payload: {
              script: true,
              scriptId: target.id,
              args: assignTyped(target.meta.args, [v]),
              specs: target.meta.args,
              mode: target.meta.output,
            },
          }
        : copyAction(v)
    } else primary = copyAction(v)
    return item(this.id, {
      id: `${e.id}:${i}:${l.title}`,
      title: l.title,
      kind: 'script',
      score: 800 - i,
      icon: l.icon ?? e.meta.icon ?? '',
      ...(l.subtitle ? { subtitle: l.subtitle } : {}),
      primary,
      actions: [copyAction(v, 'Copy value')],
    })
  }

  protected async custom(a: Action, _it: ResultItem, ctx: ProviderContext): Promise<void> {
    const p = (a.payload ?? {}) as Record<string, unknown>
    if (a.id === 'run-script') {
      // Headless path (aliases, hotkeys): trusted scripts only; the result is reported as a notification.
      const e = this.entries().find((x) => x.id === p['scriptId'])
      if (!e) throw new Error('script not found')
      const argv = e.meta.args.map(
        (s) => (p['args'] as Record<string, string>)?.[s.name] ?? s.default ?? '',
      )
      const r = await this.manager.runHeadless(
        e.path,
        argv.filter((x, i) => x !== '' || i < argv.length - 1),
      )
      const msg = r.error ?? (r.output.trim().split('\n').pop() || `exit ${r.exitCode}`)
      await ctx.effects?.notify(e.title, msg.slice(0, 200))
    } else if (a.id === 'create') {
      const lang = String(p['lang'])
      const t = TEMPLATES[lang]
      const name = String(p['name'] ?? '').trim()
      if (!t || !/^[\w .-]{1,60}$/.test(name))
        throw new Error('give the script a simple name (letters, numbers, spaces, - _ .)')
      const dir = this.cfgFile.data.folders[0]?.path ?? this.defaultDir
      await fs.mkdir(dir, { recursive: true })
      const file = join(dir, name.replace(/\s+/g, '-') + t.ext)
      await fs
        .writeFile(file, t.body(name), { mode: 0o755, flag: 'wx' })
        .catch((e: NodeJS.ErrnoException) => {
          throw new Error(
            e.code === 'EEXIST'
              ? 'a script with that name already exists'
              : 'could not create the script',
          )
        })
      if (!this.cfgFile.data.folders.length)
        await this.cfgFile.update((d) => ({ ...d, folders: [{ path: dir }] }))
      await this.reloadScripts()
      await ctx.effects?.openPath(file)
    } else if (a.id === 'add-folder') {
      const path = String(p['path'] ?? '')
      if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path))
        throw new Error('use an absolute folder path')
      await fs.stat(path).then((s) => {
        if (!s.isDirectory()) throw new Error('not a folder')
      })
      await this.cfgFile.update((d) => ({
        ...d,
        folders: d.folders.some((f) => f.path === path) ? d.folders : [...d.folders, { path }],
      }))
      await this.reloadScripts()
    } else if (a.id === 'reload') await this.reloadScripts()
  }
}
