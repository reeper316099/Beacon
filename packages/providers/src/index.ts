import { execFile } from 'node:child_process'
import type { ParsedQuery, ProviderContext, ResultItem } from '@beacon/shared'
import { FuzzyIndex } from '@beacon/matcher'
import { LiveProvider, copyAction, item } from './base'
import { calculate, convertCurrency } from './calc'
import { DEV_COMMANDS } from './devutils'
import { conversions, parseColor, toHex } from './color'
import { filterProcs, parsePs, parseTasklist, type Proc } from './processes'
import { systemCommands } from './system'
import { TimerStore, formatRemaining, parseDuration, type TimerRec } from './timers'
import type { Action } from '@beacon/shared'

export * from './base'
export * from './terminal'
export * from './ssh'
export * from './files'
export * from './bookmarks'
export * from './clipboard'
export * from './snippets'
export * from './notes'
export * from './personal'
export * from './calc'
export * from './devutils'
export * from './color'
export * from './emoji'
export * from './quicklinks'
export * from './processes'
export * from './system'
export * from './timers'

export class CalculatorProvider extends LiveProvider {
  id = 'calc'
  name = 'Calculator'
  constructor(private rates: () => Record<string, number> = () => ({})) {
    super()
  }
  protected compute(q: ParsedQuery, ctx: ProviderContext): ResultItem[] {
    if (q.trigger || q.raw.length < 2) return []
    const r = convertCurrency(q.raw, this.rates()) ?? calculate(q.raw, new Date(ctx.now()))
    if (!r) return []
    return [
      item(this.id, {
        id: 'calc:' + q.raw,
        title: r.formatted,
        subtitle: `${q.raw.trim()} · ${r.kind}`,
        kind: 'calc',
        score: 800,
        primary: copyAction(r.raw, 'Copy result'),
        actions: r.formatted !== r.raw ? [copyAction(r.formatted, 'Copy formatted')] : [],
      }),
    ]
  }
}

export class ColorProvider extends LiveProvider {
  id = 'color'
  name = 'Colors'
  protected compute(q: ParsedQuery): ResultItem[] {
    if (q.trigger) return []
    const c = parseColor(q.raw)
    if (!c) return []
    const conv = conversions(c)
    const [first, ...rest] = conv
    return [
      item(this.id, {
        id: 'color:' + toHex(c),
        title: first!.value,
        subtitle: conv.map((x) => x.value).join('  ·  '),
        kind: 'color',
        score: 700,
        icon: `color:${toHex(c)}`,
        primary: copyAction(first!.value, `Copy ${first!.label}`),
        actions: rest.map((x) => ({
          ...copyAction(x.value, `Copy ${x.label}`),
          id: 'copy-' + x.label,
        })),
      }),
    ]
  }
}

export class DevProvider extends LiveProvider {
  id = 'dev'
  name = 'Developer utilities'
  protected async compute(q: ParsedQuery, ctx: ProviderContext): Promise<ResultItem[]> {
    if (q.trigger) return []
    const [name = '', ...args] = q.terms
    const cmd = DEV_COMMANDS[name.toLowerCase()]
    if (!cmd) return []
    // Argument-taking commands only fire once there's a space after the name.
    if (
      !/\s/.test(q.raw.trim()) &&
      !['uuid', 'ulid', 'pw', 'lorem', 'ts', 'json'].includes(name.toLowerCase())
    )
      return []
    try {
      const outs = await cmd.run(args, q.raw, () =>
        ctx.effects ? ctx.effects.readClipboard() : Promise.resolve(''),
      )
      return outs.map((o, i) =>
        item(this.id, {
          id: `dev:${name}:${i}:${o.title}`,
          title: o.title,
          kind: 'dev',
          score: 600 - i,
          ...(o.subtitle ? { subtitle: o.subtitle } : {}),
          primary: copyAction(o.copy),
        }),
      )
    } catch (e) {
      return [
        item(this.id, {
          id: 'dev:err',
          title: e instanceof Error ? e.message : 'error',
          subtitle: cmd.usage,
          kind: 'dev',
          score: 100,
          primary: copyAction(cmd.usage, 'Copy usage'),
        }),
      ]
    }
  }
}

export class SystemProvider extends LiveProvider {
  id = 'system'
  name = 'System'
  private cmds = systemCommands(process.platform)
  private index = new FuzzyIndex(
    this.cmds.map((c) => [[c.title, ...c.keywords].join(' '), c] as const),
  )
  protected compute(q: ParsedQuery): ResultItem[] {
    if (q.trigger || q.text.length < 2) return []
    return this.index.search(q.text, 5).map(({ item: c, score }) =>
      item(this.id, {
        id: 'sys:' + c.id,
        title: c.title,
        kind: 'system',
        score: score + 50,
        ...(c.confirm ? { subtitle: 'Asks for confirmation' } : {}),
        primary: {
          id: 'run',
          title: c.title,
          kind: 'run',
          confirm: c.confirm,
          payload: c.steps.length === 1 ? c.steps[0] : { steps: c.steps },
        } as Action,
      }),
    )
  }
}

export class TimerProvider extends LiveProvider {
  id = 'timer'
  name = 'Timers'
  mode = 'prefix-only' as const
  triggers = ['timer ', 'timers']
  constructor(readonly store: TimerStore) {
    super()
  }
  protected compute(q: ParsedQuery, ctx: ProviderContext): ResultItem[] {
    const out: ResultItem[] = []
    const [dur, ...label] = q.terms
    const ms = dur ? parseDuration(dur) : null
    if (ms) {
      out.push(
        item(this.id, {
          id: `new:${dur}:${label.join(' ')}`,
          title: `Start ${formatRemaining(ms)} timer${label.length ? ': ' + label.join(' ') : ''}`,
          kind: 'timer',
          score: 900,
          primary: {
            id: 'start',
            title: 'Start timer',
            kind: 'custom',
            payload: { ms, label: label.join(' ') },
          },
        }),
      )
    }
    for (const t of this.store.list())
      out.push(
        item(this.id, {
          id: 'run:' + t.id,
          title: `${t.label} · ${formatRemaining(t.endsAt - ctx.now())} left`,
          kind: 'timer',
          score: 500,
          primary: { id: 'cancel', title: 'Cancel timer', kind: 'custom', payload: { id: t.id } },
        }),
      )
    return out
  }
  protected async custom(a: Action): Promise<void> {
    const p = a.payload as { ms?: number; label?: string; id?: string }
    if (a.id === 'start' && p.ms) this.store.start(p.ms, p.label ?? '')
    else if (a.id === 'cancel' && p.id) this.store.cancel(p.id)
  }
}

function listProcs(): Promise<Proc[]> {
  const [file, args] =
    process.platform === 'win32'
      ? ['tasklist', ['/FO', 'CSV', '/NH']]
      : ['ps', ['-axo', 'pid=,comm=']]
  return new Promise((res) =>
    execFile(
      file as string,
      args as string[],
      { maxBuffer: 16 << 20, timeout: 5000, windowsHide: true },
      (e, out) => res(e ? [] : process.platform === 'win32' ? parseTasklist(out) : parsePs(out)),
    ),
  )
}

export class ProcessProvider extends LiveProvider {
  id = 'processes'
  name = 'Processes'
  mode = 'prefix-only' as const
  triggers = ['kill ']
  protected async compute(q: ParsedQuery): Promise<ResultItem[]> {
    const procs = filterProcs(await listProcs(), q.text, [process.pid, process.ppid])
    return procs.map((p, i) =>
      item(this.id, {
        id: `p:${p.pid}`,
        title: p.name,
        subtitle: `PID ${p.pid} · asks for confirmation`,
        kind: 'process',
        score: 500 - i,
        primary: {
          id: 'kill',
          title: `Quit ${p.name}`,
          kind: 'custom',
          confirm: true,
          payload: { pid: p.pid },
        },
      }),
    )
  }
  protected async custom(a: Action): Promise<void> {
    const pid = (a.payload as { pid?: number }).pid
    if (!Number.isInteger(pid) || (pid as number) <= 1) throw new Error('bad pid')
    process.kill(pid as number, 'SIGTERM')
  }
}

export type { TimerRec }
