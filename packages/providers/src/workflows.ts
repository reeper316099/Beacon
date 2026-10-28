import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { Action, ParsedQuery, ProviderContext, ResultItem } from '@beacon/shared'
import { LiveProvider, item, spawnArgv } from './base'

const Os = z.array(z.enum(['macos', 'windows', 'linux'])).optional()
const StepBase = { os: Os }

export const WorkflowSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: z.string().min(1).max(80),
  keyword: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,19}$/i),
  description: z.string().max(200).optional(),
  args: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Za-z_]\w{0,30}$/),
        prompt: z.string().max(100).optional(),
        default: z.string().max(500).optional(),
      }),
    )
    .max(8)
    .default([]),
  steps: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('url'), url: z.string().max(2000), ...StepBase }),
        z.object({ kind: z.literal('open'), path: z.string().max(1000), ...StepBase }),
        z.object({ kind: z.literal('app'), name: z.string().max(200), ...StepBase }),
        z.object({ kind: z.literal('copy'), text: z.string().max(20_000), ...StepBase }),
        z.object({
          kind: z.literal('run'),
          file: z.string().max(500),
          args: z.array(z.string().max(2000)).max(50).default([]),
          ...StepBase,
        }),
        z.object({ kind: z.literal('wait'), ms: z.number().int().min(0).max(60_000), ...StepBase }),
        z.object({
          kind: z.literal('script'),
          script: z.string().max(300),
          args: z.array(z.string().max(2000)).max(20).default([]),
          ...StepBase,
        }),
      ]),
    )
    .min(1)
    .max(30),
})
export type Workflow = z.infer<typeof WorkflowSchema>
export type Step = Workflow['steps'][number]

const osName = (p: NodeJS.Platform) =>
  p === 'darwin' ? 'macos' : p === 'win32' ? 'windows' : 'linux'

/** Parse a workflow file (JSON or YAML). */
export function parseWorkflow(
  text: string,
  ext: string,
): { ok: true; workflow: Workflow } | { ok: false; error: string } {
  let raw: unknown
  try {
    raw = ext === '.json' ? JSON.parse(text) : parseYaml(text)
  } catch (e) {
    return {
      ok: false,
      error: `not valid ${ext === '.json' ? 'JSON' : 'YAML'}: ${(e as Error).message.split('\n')[0]}`,
    }
  }
  const r = WorkflowSchema.safeParse(raw)
  return r.success
    ? { ok: true, workflow: r.data }
    : {
        ok: false,
        error: `${r.error.issues[0]?.path.join('.') || 'workflow'}: ${r.error.issues[0]?.message}`,
      }
}

/** Substitute {name}, {query} (all words) and {clipboard} in a template string. Values are data, never code. */
export function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{([A-Za-z_]\w*)\}/g, (m, k: string) => (k in vars ? (vars[k] as string) : m))
}

export function needsConfirm(w: Workflow): boolean {
  return w.steps.some((s) => s.kind === 'run' || s.kind === 'script')
}

export interface WorkflowDeps {
  ctx: ProviderContext
  platform?: NodeJS.Platform
  /** Run a trusted script headlessly (the ScriptManager). */
  runScript?: (ref: string, args: string[]) => Promise<{ ok: boolean; error?: string }>
  sleep?: (ms: number) => Promise<void>
}

/** Execute steps in order. A failing step stops the workflow and is reported; nothing is run through a shell. */
export async function runWorkflow(
  w: Workflow,
  args: Record<string, string>,
  d: WorkflowDeps,
): Promise<void> {
  const platform = d.platform ?? process.platform
  const fx = d.ctx.effects
  const vars: Record<string, string> = { ...args }
  if (w.steps.some((s) => JSON.stringify(s).includes('{clipboard}')))
    vars['clipboard'] = (await fx?.readClipboard()) ?? ''
  for (const [i, step] of w.steps.entries()) {
    if (step.os && !step.os.includes(osName(platform))) continue
    try {
      switch (step.kind) {
        case 'url': {
          const u = new URL(
            fill(
              step.url,
              Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, encodeURIComponent(v)])),
            ),
          )
          if (u.protocol !== 'https:' && u.protocol !== 'http:')
            throw new Error('only http(s) URLs')
          await fx?.openUrl(u.toString())
          break
        }
        case 'open':
          await fx?.openPath(fill(step.path, vars))
          break
        case 'app':
          await spawnArgv(
            platform === 'darwin'
              ? { file: 'open', args: ['-a', fill(step.name, vars)] }
              : platform === 'win32'
                ? { file: 'explorer.exe', args: [fill(step.name, vars)] }
                : { file: fill(step.name, vars), args: [] },
          )
          break
        case 'copy':
          await fx?.copy(fill(step.text, vars))
          break
        case 'run':
          await spawnArgv(
            { file: fill(step.file, vars), args: step.args.map((a) => fill(a, vars)) },
            true,
          )
          break
        case 'wait':
          await (d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(step.ms)
          break
        case 'script': {
          const r = await d.runScript?.(
            fill(step.script, vars),
            step.args.map((a) => fill(a, vars)),
          )
          if (!r) throw new Error('scripts unavailable')
          if (!r.ok) throw new Error(r.error ?? 'script failed')
          break
        }
      }
    } catch (e) {
      throw new Error(
        `step ${i + 1} (${step.kind}) failed: ${e instanceof Error ? e.message : 'error'}`,
      )
    }
  }
}

// ---------- store + provider ----------

export class WorkflowStore {
  workflows: (Workflow & { file: string })[] = []
  problems: string[] = []
  constructor(readonly dir: string) {}

  async load(): Promise<void> {
    this.workflows = []
    this.problems = []
    let names: string[] = []
    try {
      names = (await fs.readdir(this.dir)).filter((n) => /\.(json|ya?ml)$/i.test(n)).sort()
    } catch {
      return
    }
    for (const n of names) {
      const file = join(this.dir, n)
      const r = parseWorkflow(
        await fs.readFile(file, 'utf8').catch(() => ''),
        n.slice(n.lastIndexOf('.')).toLowerCase().replace('.yml', '.yaml'),
      )
      if (r.ok) this.workflows.push({ ...r.workflow, file })
      else this.problems.push(`${n}: ${r.error}`)
    }
  }
}

export class WorkflowProvider extends LiveProvider {
  id = 'workflows'
  name = 'Workflows'
  mode = 'prefix-only' as const
  triggers: string[] = []
  constructor(
    private store: WorkflowStore,
    private runScript?: WorkflowDeps['runScript'],
  ) {
    super()
  }

  refreshTriggers(): void {
    this.triggers.length = 0
    this.triggers.push(
      ...this.store.workflows.map((w) => w.keyword + ' '),
      'workflow ',
      'workflows ',
    )
  }

  protected compute(q: ParsedQuery): ResultItem[] {
    const kw = q.trigger?.trim().toLowerCase()
    if (kw === 'workflow' || kw === 'workflows')
      return [
        ...this.store.workflows.map((w, i) =>
          item(this.id, {
            id: 'wf:' + w.id,
            title: w.name,
            subtitle: `${w.keyword} · ${w.steps.length} step(s)${w.description ? ' · ' + w.description : ''}`,
            kind: 'workflow',
            score: 500 - i,
            primary: {
              id: 'set-query',
              title: 'Use',
              kind: 'custom',
              payload: { setQuery: w.keyword + ' ' },
            },
            actions: [
              {
                id: 'reveal',
                title: 'Reveal workflow file',
                kind: 'reveal',
                payload: { path: w.file },
              },
            ],
          }),
        ),
        ...this.store.problems.map((p, i) =>
          item(this.id, {
            id: 'prob' + i,
            title: `⚠ ${p}`,
            kind: 'workflow',
            score: 10,
            primary: { id: 'noop', title: 'OK', kind: 'custom', payload: null },
          }),
        ),
      ]
    const w = this.store.workflows.find((x) => x.keyword.toLowerCase() === kw)
    if (!w) return []
    const words = q.terms
    const args: Record<string, string> = { query: words.join(' ') }
    w.args.forEach((a, i) => {
      const v = i === w.args.length - 1 ? words.slice(i).join(' ') : words[i]
      args[a.name] = v || a.default || ''
    })
    const missing = w.args.filter((a) => !args[a.name])
    return [
      item(this.id, {
        id: `run:${w.id}:${words.join(' ')}`,
        title: `Run “${w.name}”`,
        kind: 'workflow',
        score: 900,
        subtitle: missing.length
          ? `needs ${missing.map((m) => m.prompt ?? m.name).join(', ')}`
          : (w.description ?? `${w.steps.length} step(s)`),
        primary: {
          id: 'run',
          title: 'Run workflow',
          kind: 'custom',
          confirm: needsConfirm(w),
          payload: { id: w.id, args },
        },
        actions: [
          {
            id: 'reveal',
            title: 'Reveal workflow file',
            kind: 'reveal',
            payload: { path: w.file },
          },
        ],
      }),
    ]
  }

  protected async custom(a: Action, _it: ResultItem, ctx: ProviderContext): Promise<void> {
    const p = a.payload as { id: string; args: Record<string, string> }
    const w = this.store.workflows.find((x) => x.id === p.id)
    if (!w) throw new Error('workflow not found')
    await runWorkflow(w, p.args, { ctx, ...(this.runScript ? { runScript: this.runScript } : {}) })
  }
}
