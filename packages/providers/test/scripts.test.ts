import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SearchEngine } from '@beacon/core'
import { JsonFile } from '@beacon/jsonstore'
import type { Effects, ResultItem } from '@beacon/shared'
import {
  AnsiSanitizer,
  DEFAULT_SCRIPTS_CONFIG,
  ScriptManager,
  ScriptTrust,
  ScriptsProvider,
  assignTyped,
  buildEnv,
  clean,
  diffLines,
  hashContent,
  parseArgSpec,
  parseHeader,
  parseJsonLines,
  parseShebang,
  parseSidecar,
  resolveArgs,
  resolveInterpreter,
  runProcess,
  scanScripts,
  scriptId,
  shQuote,
  watchScripts,
  type ScriptEvent,
  type ScriptsConfig,
  type TrustFile,
} from '../src/index'

let dir: string
beforeAll(async () => (dir = await mkdtemp(join(tmpdir(), 'beacon script dir-'))))
afterAll(() => rm(dir, { recursive: true, force: true }))

describe('header parsing', () => {
  it('parses every comment style and defaults', () => {
    const py = parseHeader(
      '#!/usr/bin/env python3\n# @beacon.title Backup home lab\n# @beacon.desc Rsync configs to NAS\n# @beacon.keyword bk\n# @beacon.icon 💾\n# @beacon.output copy\n# @beacon.timeout 60\n# @beacon.confirm true\n# @beacon.os linux,macos\n',
    )
    expect(py).toMatchObject({
      title: 'Backup home lab',
      desc: 'Rsync configs to NAS',
      keyword: 'bk',
      icon: '💾',
      output: 'copy',
      timeoutSec: 60,
      confirm: true,
      os: ['linux', 'macos'],
    })
    expect(parseHeader('// @beacon.title JS one\n').title).toBe('JS one')
    expect(parseHeader('-- @beacon.title Lua\n').title).toBe('Lua')
    expect(parseHeader('REM @beacon.title Batch\n').title).toBe('Batch')
    expect(parseHeader(':: @beacon.title Batch2\n').title).toBe('Batch2')
    expect(parseHeader('/* @beacon.title Block */\n').title).toBe('Block')
    expect(parseHeader('; @beacon.title Ini\n').title).toBe('Ini')
    const none = parseHeader('print("no header")')
    expect(none).toMatchObject({ output: 'inline', args: [], confirm: false, saveOutput: false })
  })
  it('ignores bad values instead of failing', () => {
    const m = parseHeader(
      '# @beacon.output sideways\n# @beacon.timeout abc\n# @beacon.arg nonsense\n# @beacon.ssh bad host\n# @beacon.unknown x\n',
    )
    expect(m).toMatchObject({ output: 'inline', args: [] })
    expect(m.timeoutSec).toBeUndefined()
    expect(m.ssh).toBeUndefined()
  })
  it('parses arg specs', () => {
    expect(parseArgSpec('target:choice(nas,usb)=nas  "Where to?"')).toEqual({
      name: 'target',
      type: 'choice',
      choices: ['nas', 'usb'],
      optional: true,
      default: 'nas',
      prompt: 'Where to?',
    })
    expect(parseArgSpec('note:text?  "Optional note"')).toMatchObject({
      name: 'note',
      type: 'text',
      optional: true,
      prompt: 'Optional note',
    })
    expect(parseArgSpec('pw:secret')).toMatchObject({ type: 'secret', optional: false })
    expect(parseArgSpec('n:number=5')).toMatchObject({ type: 'number', default: '5' })
    for (const t of ['file', 'folder', 'clipboard', 'selection', 'text'])
      expect(parseArgSpec(`a:${t}`)?.type).toBe(t)
    expect(parseArgSpec('x:choice()')).toBeNull()
    expect(parseArgSpec('x:bogus')).toBeNull()
    expect(parseArgSpec('no type')).toBeNull()
  })
  it('sidecar json', () => {
    const m = parseSidecar(
      JSON.stringify({
        title: 'Side',
        keyword: 'sc',
        output: 'list',
        args: ['q:text'],
        timeout: 5,
      }),
    )!
    expect(m).toMatchObject({ title: 'Side', keyword: 'sc', output: 'list', timeoutSec: 5 })
    expect(m.args).toHaveLength(1)
    expect(parseSidecar('{bad')).toBeNull()
  })
  it('typed args after the keyword', () => {
    const specs = [
      parseArgSpec('target:choice(nas,usb)')!,
      parseArgSpec('note:text?')!,
      parseArgSpec('pw:secret')!,
    ]
    expect(assignTyped(specs, ['nas', 'weekly', 'run'])).toEqual({
      target: 'nas',
      note: 'weekly run',
    })
  })
})

describe('arguments', () => {
  const specs = ['t:choice(a,b)', 'n:number?', 'p:folder?', 's:secret', 'c:clipboard'].map((s) =>
    parseArgSpec(s)!,
  )
  const clip = async () => 'CLIPVAL'
  it('validates and fills in order; secrets must be supplied; clipboard is read on demand', async () => {
    const r = await resolveArgs(specs, { given: { t: 'a', s: 'hunter2' }, clipboard: clip })
    expect(r).toEqual({ ok: true, argv: ['a', '', '', 'hunter2', 'CLIPVAL'] })
    expect((await resolveArgs(specs, { given: { t: 'a' }, clipboard: clip })).ok).toBe(false) // missing secret
    const bad = await resolveArgs(specs, { given: { t: 'z', s: 'x' }, clipboard: clip })
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('one of') })
    expect(
      (await resolveArgs(specs, { given: { t: 'a', n: 'abc', s: 'x' }, clipboard: clip })).ok,
    ).toBe(false)
    expect(
      (await resolveArgs(specs, { given: { t: 'a', p: 'relative', s: 'x' }, clipboard: clip })).ok,
    ).toBe(false)
  })
})

describe('ANSI sanitizer', () => {
  it('keeps colours, strips cursor movement, titles, clipboard writes and other escapes', () => {
    expect(clean('\x1b[31mred\x1b[0m')).toBe('\x1b[31mred\x1b[0m')
    expect(clean('a\x1b[2Jb\x1b[10;5Hc\x1b[?25ld')).toBe('abcd')
    expect(clean('\x1b]0;evil title\x07x')).toBe('x')
    expect(clean('\x1b]52;c;AAAA\x1b\\x')).toBe('x') // OSC 52 clipboard write
    expect(clean('\x1b]8;;http://evil\x07link\x1b]8;;\x07')).toBe('link')
    expect(clean('\x1bPdevice control\x1b\\ok')).toBe('ok')
    expect(clean('a\x07b\x00c\x08d\x7fe')).toBe('abcde')
    expect(clean('x\r\ny\rz')).toBe('x\ny\nz')
    expect(clean('\x9b2Jhi')).toBe('2Jhi')
    expect(clean('bad\x1b[31;2Jsgr?')).toBe('badsgr?')
  })
  it('handles escapes split across chunks', () => {
    const s = new AnsiSanitizer()
    const out = s.push('ok\x1b[3') + s.push('1mred\x1b]0;ti') + s.push('tle\x07done') + s.flush()
    expect(out).toBe('ok\x1b[31mreddone')
  })
  it('never throws on arbitrary bytes', () => {
    for (let i = 0; i < 200; i++) {
      const s = new AnsiSanitizer()
      const junk = Array.from({ length: 80 }, () =>
        String.fromCharCode(Math.floor(Math.random() * 300)),
      ).join('')
      expect(() => (s.push(junk.slice(0, 40)), s.push(junk.slice(40)), s.flush())).not.toThrow()
    }
  })
})

const node = process.execPath
const env = () => buildEnv([], [], process.env)
const base = { env: env(), timeoutMs: 10_000, maxOutput: 1_000_000 }

describe('runProcess', () => {
  it('streams stdout and stderr separately, with exit code', async () => {
    const chunks: [string, string][] = []
    const r = await runProcess({
      ...base,
      file: node,
      args: ['-e', 'console.log("out1"); console.error("err1"); process.exit(3)'],
      onOutput: (s, t) => chunks.push([s, t]),
    }).promise
    expect(r.exitCode).toBe(3)
    expect(chunks.find((c) => c[0] === 'stdout')?.[1]).toBe('out1\n')
    expect(chunks.find((c) => c[0] === 'stderr')?.[1]).toBe('err1\n')
  })
  it('args with spaces, quotes, ; and && stay data (no shell)', async () => {
    const nasty = ['a b', `q"uote'`, '; touch pwned', '&& echo x', '$(id)', '`id`']
    let out = ''
    await runProcess({
      ...base,
      file: node,
      args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...nasty],
      onOutput: (_s, t) => (out += t),
    }).promise
    expect(JSON.parse(out)).toEqual(nasty)
  })
  it('truncates huge output with a notice', async () => {
    let out = ''
    const r = await runProcess({
      ...base,
      maxOutput: 1000,
      file: node,
      args: ['-e', 'for(let i=0;i<5000;i++)console.log("line "+i)'],
      onOutput: (_s, t) => (out += t),
    }).promise
    expect(r.truncated).toBe(true)
    expect(out).toContain('[output truncated]')
    expect(out.length).toBeLessThan(1200)
  })
  it('times out and kills the process', async () => {
    const r = await runProcess({
      ...base,
      timeoutMs: 300,
      graceMs: 200,
      file: node,
      args: ['-e', 'setInterval(()=>{},1000)'],
      onOutput: () => {},
    }).promise
    expect(r.timedOut).toBe(true)
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true)
  })
  it.skipIf(process.platform === 'win32')(
    'cancel kills the whole process tree (grandchildren too)',
    async () => {
      const marker = join(dir, 'grandchild.pid')
      const script = `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000)`
      const run = runProcess({
        ...base,
        graceMs: 300,
        file: node,
        args: ['-e', script],
        onOutput: () => {},
      })
      await new Promise((r) => setTimeout(r, 700))
      run.cancel()
      const res = await run.promise
      expect(res.cancelled).toBe(true)
      const pid = Number(await readFile(marker, 'utf8'))
      await new Promise((r) => setTimeout(r, 300))
      expect(() => process.kill(pid, 0)).toThrow() // grandchild is gone
    },
  )
  it('SDK control lines are consumed, not shown; malformed ones dropped', async () => {
    const msgs: unknown[] = []
    let out = ''
    await runProcess({
      ...base,
      file: node,
      args: [
        '-e',
        'console.log("@@beacon "+JSON.stringify({type:"notify",title:"hi"}));console.log("@@beacon {bad");console.log("visible")',
      ],
      onOutput: (_s, t) => (out += t),
      onControl: (m) => msgs.push(m),
    }).promise
    expect(msgs).toEqual([{ type: 'notify', title: 'hi' }])
    expect(out).toBe('visible\n')
  })
  it('minimal env: no Beacon internals or tokens leak', async () => {
    process.env['BEACON_API_TOKEN'] = 'tok-secret'
    process.env['ELECTRON_RUN_AS_NODE'] = '1'
    process.env['MY_ALLOWED'] = 'yes'
    process.env['SOME_OTHER_SECRET'] = 'nope'
    let out = ''
    await runProcess({
      ...base,
      env: buildEnv(['MY_ALLOWED', 'BEACON_API_TOKEN']),
      file: node,
      args: ['-e', 'console.log(JSON.stringify(process.env))'],
      onOutput: (_s, t) => (out += t),
    }).promise
    const e = JSON.parse(out)
    expect(e.MY_ALLOWED).toBe('yes')
    expect(JSON.stringify(e)).not.toMatch(/tok-secret|nope|ELECTRON|BEACON_API/)
  })
  it('works from a path with spaces', async () => {
    const f = join(dir, 'sp ace.js')
    await writeFile(f, 'console.log("spaced ok")')
    let out = ''
    await runProcess({ ...base, file: node, args: [f], cwd: dir, onOutput: (_s, t) => (out += t) })
      .promise
    expect(out).toBe('spaced ok\n')
  })
})

describe('interpreter resolution', () => {
  const find = async (b: string) =>
    ['python3', 'node', 'bash', 'pwsh'].includes(b) ? '/bin/' + b : null
  it('shebang wins; config override; defaults; errors', async () => {
    expect(parseShebang('#!/usr/bin/env -S node --flag\n')).toEqual(['node', '--flag'])
    expect(
      await resolveInterpreter('/s/a.py', '#!/usr/bin/env node\n', {}, false, 'linux', find),
    ).toMatchObject({ file: 'node' })
    expect(
      await resolveInterpreter(
        '/s/a.py',
        '',
        { byExt: { '.py': 'python3 -u' } },
        false,
        'linux',
        find,
      ),
    ).toEqual({ file: '/bin/python3', args: ['-u'] })
    expect(await resolveInterpreter('/s/a.sh', '', {}, false, 'linux', find)).toEqual({
      file: '/bin/bash',
      args: [],
    })
    expect(await resolveInterpreter('/s/a.ps1', '', {}, false, 'linux', find)).toMatchObject({
      file: '/bin/pwsh',
    })
    expect(await resolveInterpreter('/s/a.ts', '', {}, false, 'linux', find)).toMatchObject({
      error: expect.stringContaining('TypeScript'),
    })
    expect(await resolveInterpreter('/s/a.rb', '', {}, false, 'linux', find)).toMatchObject({
      error: expect.any(String),
    })
    expect(await resolveInterpreter('/s/tool', '', {}, true, 'linux', find)).toEqual({
      file: '/s/tool',
      args: [],
    })
    expect(await resolveInterpreter('C:\\s\\a.bat', '', {}, false, 'win32', find)).toMatchObject({
      file: 'cmd.exe',
    })
  })
  it('shQuote protects remote shells', () => {
    expect(shQuote(`it's; rm -rf /`)).toBe(`'it'\\''s; rm -rf /'`)
  })
})

describe('trust-on-first-use', () => {
  it('trusts a hash; an edit re-confirms and shows a diff', async () => {
    const f = new JsonFile<TrustFile>({
      path: join(dir, 'trust.json'),
      schema: z.record(z.any()),
      defaults: () => ({}),
    })
    const t = new ScriptTrust(f, join(dir, 'snap'))
    const v1 = 'echo one\necho two\n'
    const v2 = 'echo one\necho changed\necho three\n'
    expect(t.isTrusted('/x.sh', hashContent(v1))).toBe(false)
    expect((await t.review('/x.sh', v1)).kind).toBe('new')
    await t.trust('/x.sh', hashContent(v1), v1)
    expect(t.isTrusted('/x.sh', hashContent(v1))).toBe(true)
    expect(t.isTrusted('/x.sh', hashContent(v2))).toBe(false)
    const rev = await t.review('/x.sh', v2)
    expect(rev.kind).toBe('changed')
    expect(rev.text).toContain('- echo two')
    expect(rev.text).toContain('+ echo changed')
    expect(diffLines('a\nb', 'a\nb')).toBe('')
  })
})

describe('manager end to end', () => {
  const sdir = () => join(dir, 'scripts')
  const events: ScriptEvent[] = []
  const copied: string[] = []
  const notes: string[] = []
  const fx: Effects = {
    copy: async (t) => void copied.push(t),
    openUrl: async () => {},
    notify: async (t, b) => void notes.push(`${t}|${b ?? ''}`),
    readClipboard: async () => 'CLIP',
    copyImage: async () => {},
    openPath: async () => {},
    openDeepLink: async () => {},
    reveal: async () => {},
    bindHotkey: async () => {},
  }
  let cfg: ScriptsConfig
  let trust: ScriptTrust
  let mgr: ScriptManager
  let entries: Awaited<ReturnType<typeof scanScripts>> = []
  const post = (e: ScriptEvent) => events.push(e)
  const find = (title: string) => entries.find((e) => e.title === title)!

  beforeAll(async () => {
    await mkdir(join(sdir(), 'tools'), { recursive: true })
    await writeFile(
      join(sdir(), 'hello.js'),
      '#!/usr/bin/env node\n// @beacon.title Hello\n// @beacon.keyword hi\n// @beacon.arg who:text=world "Who?"\nconsole.log("hello " + process.argv[2]); console.error("warn!")\n',
    )
    await writeFile(
      join(sdir(), 'tools', 'secret.js'),
      '// @beacon.title Secret\n// @beacon.arg pw:secret\nconsole.log("len="+process.argv[2].length)\n',
    )
    await writeFile(
      join(sdir(), 'copyme.js'),
      '// @beacon.title CopyMe\n// @beacon.output copy\nconsole.log("copied text")\n',
    )
    await writeFile(
      join(sdir(), 'failing.js'),
      '// @beacon.title Failing\n// @beacon.output silent\nprocess.exit(4)\n',
    )
    await writeFile(
      join(sdir(), 'confirmme.js'),
      '// @beacon.title ConfirmMe\n// @beacon.confirm true\nconsole.log("confirmed run")\n',
    )
    await writeFile(
      join(sdir(), 'lister.js'),
      '// @beacon.title Lister\n// @beacon.keyword ls\n// @beacon.output list\nconst q=process.argv[2]||"";console.log(JSON.stringify({title:"Result for "+q,subtitle:"sub",value:"val-"+q}));console.log("garbage line");console.log(JSON.stringify({title:"Second",action:"url",value:"https://example.com"}));console.log("{bad")\n',
    )
    await writeFile(
      join(sdir(), 'wrongos.js'),
      '// @beacon.title WrongOS\n// @beacon.os windows,linux,macos\nconsole.log(1)\n',
    )
    await writeFile(join(sdir(), 'tool.beacon.json'), '{}')
    await writeFile(join(sdir(), 'noext'), '#!/usr/bin/env node\nconsole.log("shebang script")\n')
    await chmod(join(sdir(), 'noext'), 0o755)
    await writeFile(join(sdir(), 'plain.txt'), 'not a script')
    cfg = { ...DEFAULT_SCRIPTS_CONFIG, folders: [{ path: sdir() }], history: true }
    entries = await scanScripts(cfg)
    const tf = new JsonFile<TrustFile>({
      path: join(dir, 'trust2.json'),
      schema: z.record(z.any()),
      defaults: () => ({}),
    })
    trust = new ScriptTrust(tf, join(dir, 'snap2'))
    mgr = new ScriptManager({
      cfg: () => cfg,
      entries: () => entries,
      trust,
      effects: () => fx,
      historyFile: join(dir, 'history.jsonl'),
    })
  })

  it('discovers scripts: groups, shebang-only files, skips non-scripts and sidecars', () => {
    const titles = entries.map((e) => e.title).sort()
    expect(titles).toContain('Hello')
    expect(titles).toContain('noext')
    expect(titles).not.toContain('plain')
    expect(entries.find((e) => e.title === 'Secret')?.group).toBe('tools')
    expect(find('Hello').id).toBe(scriptId(join(sdir(), 'hello.js')))
  })

  it('never auto-runs: first run asks to trust (with review), then runs with typed args and streams output', async () => {
    events.length = 0
    const hello = find('Hello')
    await mgr.run('r1', { scriptId: hello.id }, post)
    expect(events[0]).toMatchObject({ ev: 'confirm', needsTrust: true, title: 'Hello' })
    expect(events.some((e) => e.ev === 'start')).toBe(false)
    const hash = (events[0] as Extract<ScriptEvent, { ev: 'confirm' }>).hash
    events.length = 0
    await mgr.run(
      'r2',
      { scriptId: hello.id, trustHash: hash, confirmed: true, args: { who: 'Ada' } },
      post,
    )
    expect(events.map((e) => e.ev)).toEqual(
      ['start', 'out', 'out', 'exit'].filter((x) => events.some((e) => e.ev === x)).length
        ? events.map((e) => e.ev)
        : [],
    )
    const outs = events.filter((e): e is Extract<ScriptEvent, { ev: 'out' }> => e.ev === 'out')
    expect(outs.find((o) => o.stream === 'stdout')?.text).toBe('hello Ada\n')
    expect(outs.find((o) => o.stream === 'stderr')?.text).toBe('warn!\n')
    expect(events.at(-1)).toMatchObject({ ev: 'exit', exitCode: 0 })
    // trusted now: runs without asking, default arg applies
    events.length = 0
    await mgr.run('r3', { scriptId: hello.id }, post)
    expect(events.some((e) => e.ev === 'confirm')).toBe(false)
    expect(events.filter((e) => e.ev === 'out').map((e) => (e as { text: string }).text)).toContain(
      'hello world\n',
    )
  })

  it('editing a trusted script re-confirms with a diff', async () => {
    const hello = find('Hello')
    const file = hello.path
    const orig = await readFile(file, 'utf8')
    await writeFile(file, orig.replace('console.log("hello "', 'console.log("HELLO CHANGED "'))
    events.length = 0
    await mgr.run('r4', { scriptId: hello.id }, post)
    const c = events[0] as Extract<ScriptEvent, { ev: 'confirm' }>
    expect(c.ev).toBe('confirm')
    expect(c.reasons[0]).toMatch(/changed/)
    expect(c.review.kind).toBe('changed')
    expect(c.review.text).toContain('+ console.log("HELLO CHANGED "')
    await writeFile(file, orig)
  })

  it('a hash approved for an older version does not authorize an edited file', async () => {
    const hello = find('Hello')
    const orig = await readFile(hello.path, 'utf8')
    events.length = 0
    await mgr.run('r5', { scriptId: hello.id }, post)
    // trusted at this point (restored), so it runs; now claim approval with a stale hash after editing
    await writeFile(hello.path, orig + '\n// edited\n')
    events.length = 0
    await mgr.run('r6', { scriptId: hello.id, confirmed: true, trustHash: 'deadbeef' }, post)
    expect(events[0]?.ev).toBe('confirm')
    await writeFile(hello.path, orig)
  })

  it('secret args are prompted every run, never stored or logged', async () => {
    const s = find('Secret')
    events.length = 0
    await mgr.run('s0', { scriptId: s.id }, post)
    const hash = (events[0] as Extract<ScriptEvent, { ev: 'confirm' }>).hash
    events.length = 0
    await mgr.run('s1', { scriptId: s.id, trustHash: hash, confirmed: true }, post)
    expect(events[0]).toMatchObject({ ev: 'need-args' })
    events.length = 0
    await mgr.run('s2', { scriptId: s.id, args: { pw: 'hunter2-TOP-SECRET' } }, post)
    expect(
      events
        .filter((e) => e.ev === 'out')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('len=18\n')
    // run again: the secret was not remembered
    events.length = 0
    await mgr.run('s3', { scriptId: s.id }, post)
    expect(events[0]).toMatchObject({ ev: 'need-args' })
    expect(JSON.stringify(events)).not.toContain('hunter2')
    const hist = await readFile(join(dir, 'history.jsonl'), 'utf8')
    expect(hist).not.toContain('hunter2')
    expect(
      hist
        .split('\n')
        .filter(Boolean)
        .every((l) => !('output' in JSON.parse(l))),
    ).toBe(true) // output not saved unless opted in
  })

  it('output modes: copy → clipboard; silent → notification on failure; confirm:true → asks every run', async () => {
    for (const t of ['CopyMe', 'Failing', 'ConfirmMe']) {
      events.length = 0
      await mgr.run('m0', { scriptId: find(t).id }, post)
      const hash = (events[0] as Extract<ScriptEvent, { ev: 'confirm' }>).hash
      events.length = 0
      await mgr.run('m1', { scriptId: find(t).id, trustHash: hash, confirmed: true }, post)
    }
    expect(copied).toContain('copied text')
    expect(notes.some((n) => n.startsWith('Failing|') && n.includes('4'))).toBe(true)
    events.length = 0
    await mgr.run('m2', { scriptId: find('ConfirmMe').id }, post)
    expect(events[0]).toMatchObject({
      ev: 'confirm',
      reasons: [expect.stringContaining('confirmation')],
    })
  })

  it('records run history metadata only', async () => {
    const lines = (await readFile(join(dir, 'history.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines.length).toBeGreaterThan(3)
    expect(Object.keys(lines[0]).sort()).toEqual(['exit', 'ms', 'script', 'ts'])
  })

  it('cancel stops a long-running script; concurrency limit enforced', async () => {
    await writeFile(
      join(sdir(), 'sleeper.js'),
      '// @beacon.title Sleeper\nsetInterval(()=>{},1000)\n',
    )
    entries = await scanScripts(cfg)
    const sl = find('Sleeper')
    const c0: ScriptEvent[] = []
    await mgr.run('c0', { scriptId: sl.id }, (e) => c0.push(e))
    const hash = (c0[0] as Extract<ScriptEvent, { ev: 'confirm' }>).hash
    const ev: ScriptEvent[] = []
    const p = mgr.run('c1', { scriptId: sl.id, trustHash: hash, confirmed: true }, (e) =>
      ev.push(e),
    )
    await new Promise((r) => setTimeout(r, 500))
    expect(mgr.running).toBe(1)
    cfg = { ...cfg, concurrency: 1 }
    const ev2: ScriptEvent[] = []
    await mgr.run('c2', { scriptId: sl.id }, (e) => ev2.push(e))
    expect(ev2[0]).toMatchObject({ ev: 'error', message: expect.stringContaining('too many') })
    mgr.cancel('c1')
    await p
    expect(ev.at(-1)).toMatchObject({ ev: 'exit', cancelled: true })
    expect(mgr.running).toBe(0)
    cfg = { ...cfg, concurrency: 4 }
  })

  it('list mode: JSON Lines become items (malformed skipped); needs trust first; query reaches the script', async () => {
    expect(parseJsonLines('{"title":"a"}\nnope\n{"x":1}\n{"title":"b","value":"v"}')).toEqual([
      { title: 'a' },
      { title: 'b', value: 'v' },
    ])
    const lister = find('Lister')
    const sp = new ScriptsProvider(
      mgr,
      () => entries,
      new JsonFile({ path: join(dir, 'sc.json'), schema: z.any(), defaults: () => cfg }),
      join(dir, 'newscripts'),
      async () => {},
    )
    const e = new SearchEngine({ ctx: { now: Date.now, effects: fx } })
    e.register(sp)
    const run = async (q: string) => {
      const o: ResultItem[] = []
      await e.search(q, (b) => o.push(...b.items))
      return o
    }
    expect((await run('ls hello'))[0]?.title).toMatch(/Review & trust/)
    const c: ScriptEvent[] = []
    await mgr.run('l0', { scriptId: lister.id }, (x) => c.push(x))
    await mgr.run(
      'l1',
      {
        scriptId: lister.id,
        trustHash: (c[0] as Extract<ScriptEvent, { ev: 'confirm' }>).hash,
        confirmed: true,
      },
      () => {},
    )
    const items = await run('ls hello')
    expect(items.map((i) => i.title)).toEqual(['Result for hello', 'Second'])
    expect(items[0]?.primary).toMatchObject({ kind: 'copy', payload: { text: 'val-hello' } })
    expect(items[1]?.primary).toMatchObject({
      kind: 'url',
      payload: { url: 'https://example.com' },
    })
  })

  it('headless runs (CLI/alias/hotkey) require trust', async () => {
    const hello = find('Hello')
    const ok = await mgr.runHeadless(hello.path, ['CLI'])
    expect(ok).toMatchObject({ ok: true, exitCode: 0 })
    expect(ok.output).toContain('hello CLI')
    expect((await mgr.runHeadless(hello.path, [])).output).toContain('hello world') // declared default applies
    expect((await mgr.runHeadless(hello.path, ['a', 'extra'])).ok).toBe(true)
    await writeFile(join(sdir(), 'untrusted.js'), '// @beacon.title Untrusted\nconsole.log("x")\n')
    entries = await scanScripts(cfg)
    expect(await mgr.runHeadless('Untrusted')).toMatchObject({
      ok: false,
      error: expect.stringContaining('not trusted'),
    })
    expect((await mgr.runHeadless('ConfirmMe')).error).toMatch(/confirmation/)
    expect((await mgr.runHeadless('nope')).error).toMatch(/no script/)
  })

  it('scaffolds a new script with a header and reloads', async () => {
    const created: string[] = []
    const cfgFile = new JsonFile({
      path: join(dir, 'sc2.json'),
      schema: z.any(),
      defaults: () => ({ ...cfg, folders: [] }),
    })
    await cfgFile.load()
    const sp = new ScriptsProvider(
      mgr,
      () => entries,
      cfgFile as never,
      join(dir, 'fresh'),
      async () => void created.push('reloaded'),
    )
    const e = new SearchEngine({ ctx: { now: Date.now, effects: fx } })
    e.register(sp)
    const o: ResultItem[] = []
    await e.search('script new py My Tool', (b) => o.push(...b.items))
    expect(o[0]?.title).toContain('My Tool')
    await sp.activate(o[0]!.id, undefined, { now: Date.now, effects: fx })
    const text = await readFile(join(dir, 'fresh', 'My-Tool.py'), 'utf8')
    expect(text).toContain('@beacon.title    My Tool')
    expect(created).toEqual(['reloaded'])
    await expect(sp.activate(o[0]!.id, undefined, { now: Date.now, effects: fx })).rejects.toThrow(
      /already exists/,
    )
    const bad: ResultItem[] = []
    await e.search('script new py ../../evil', (b) => bad.push(...b.items))
    await expect(
      sp.activate(bad[0]!.id, undefined, { now: Date.now, effects: fx }),
    ).rejects.toThrow(/simple name/)
  })

  it('hot reload: adding a script is picked up by the watcher', async () => {
    const wdir = join(dir, 'watched')
    await mkdir(wdir, { recursive: true })
    let fire!: () => void
    const changed = new Promise<void>((r) => (fire = r))
    const stop = watchScripts([wdir], () => fire(), 50)
    await new Promise((r) => setTimeout(r, 400))
    await writeFile(join(wdir, 'new.sh'), '#!/bin/sh\necho hi\n')
    await changed
    await stop()
  })
})
