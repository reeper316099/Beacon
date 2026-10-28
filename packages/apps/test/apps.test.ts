import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AppsProvider,
  discoverLinux,
  discoverMac,
  discoverWindows,
  entryFromDesktop,
  expandExec,
  launch,
  parsePlistXml,
  parseStartApps,
  splitExec,
  watchRoots,
} from '../src/index'
import { SearchEngine } from '@beacon/core'

let tmp: string
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'beacon-apps-'))
})
afterAll(() => rm(tmp, { recursive: true, force: true }))

describe('linux exec field codes', () => {
  const ctx = { name: 'My App', icon: 'myicon', path: '/x/app.desktop' }
  it('strips file/url codes', () => {
    expect(expandExec('firefox %u', ctx)).toEqual(['firefox'])
    expect(expandExec('gimp-2.10 %F', ctx)).toEqual(['gimp-2.10'])
    expect(expandExec('app --new-window %U --flag', ctx)).toEqual(['app', '--new-window', '--flag'])
  })
  it('expands %i %c %k and %%', () => {
    expect(expandExec('app %i %c %k', ctx)).toEqual([
      'app',
      '--icon',
      'myicon',
      'My App',
      '/x/app.desktop',
    ])
    expect(expandExec('app --pct=100%%', ctx)).toEqual(['app', '--pct=100%'])
  })
  it('handles quoted args with spaces and escapes', () => {
    expect(splitExec('"/opt/My App/run" --name "a \\"b\\"" x')).toEqual([
      '/opt/My App/run',
      '--name',
      'a "b"',
      'x',
    ])
  })
  it('never treats shell metacharacters specially', () => {
    expect(expandExec('sh -c "echo hi; rm -rf /" %f', ctx)).toEqual([
      'sh',
      '-c',
      'echo hi; rm -rf /',
    ])
  })
})

const desktop = (extra = '') => `[Desktop Entry]
Type=Application
Name=Editor
Name[de]=Bearbeiter
Exec=editor %F
Icon=editor
Keywords=text;code;
Actions=new;

[Desktop Action new]
Name=New Window
Exec=editor --new-window
${extra}`

describe('linux .desktop', () => {
  it('parses name, keywords, actions, localized name', () => {
    const e = entryFromDesktop('editor.desktop', '/p', desktop(), { env: { LANG: 'de_DE.UTF-8' } })!
    expect(e.name).toBe('Bearbeiter')
    expect(e.keywords).toEqual(['text', 'code'])
    expect(e.launch).toEqual({ file: 'editor', args: [] })
    expect(e.actions[0]).toMatchObject({
      title: 'New Window',
      launch: { file: 'editor', args: ['--new-window'] },
    })
  })
  it('honors NoDisplay/Hidden/OnlyShowIn/NotShowIn', () => {
    const base = '[Desktop Entry]\nType=Application\nName=X\nExec=x\n'
    expect(entryFromDesktop('a', '/p', base + 'NoDisplay=true\n')).toBeNull()
    expect(entryFromDesktop('a', '/p', base + 'Hidden=true\n')).toBeNull()
    expect(
      entryFromDesktop('a', '/p', base + 'OnlyShowIn=KDE;\n', {
        env: { XDG_CURRENT_DESKTOP: 'GNOME' },
      }),
    ).toBeNull()
    expect(
      entryFromDesktop('a', '/p', base + 'OnlyShowIn=GNOME;\n', {
        env: { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' },
      }),
    ).not.toBeNull()
    expect(
      entryFromDesktop('a', '/p', base + 'NotShowIn=GNOME;\n', {
        env: { XDG_CURRENT_DESKTOP: 'GNOME' },
      }),
    ).toBeNull()
    expect(entryFromDesktop('a', '/p', '[Desktop Entry]\nType=Link\nName=X\nExec=x')).toBeNull()
  })
  it('wraps Terminal=true in the configured terminal', () => {
    const e = entryFromDesktop(
      't',
      '/p',
      '[Desktop Entry]\nType=Application\nName=Htop\nExec=htop\nTerminal=true',
      {
        terminal: ['kitty', '-e'],
      },
    )!
    expect(e.launch).toEqual({ file: 'kitty', args: ['-e', 'htop'] })
  })
  it('discovers across dirs; earlier dir wins on same id', async () => {
    const a = join(tmp, 'a/applications')
    const b = join(tmp, 'b/applications')
    await mkdir(join(a, 'sub'), { recursive: true })
    await mkdir(b, { recursive: true })
    await writeFile(
      join(a, 'one.desktop'),
      '[Desktop Entry]\nType=Application\nName=One A\nExec=one-a',
    )
    await writeFile(
      join(b, 'one.desktop'),
      '[Desktop Entry]\nType=Application\nName=One B\nExec=one-b',
    )
    await writeFile(
      join(a, 'sub/two.desktop'),
      '[Desktop Entry]\nType=Application\nName=Two\nExec=two',
    )
    const apps = await discoverLinux({ dirs: [a, b] })
    expect(apps.map((x) => x.name).sort()).toEqual(['One A', 'Two'])
  })
})

describe('macOS bundles', () => {
  it('reads Info.plist names, skips background apps, falls back to folder name', async () => {
    const root = join(tmp, 'mac')
    const mk = async (n: string, plist?: string) => {
      await mkdir(join(root, n, 'Contents'), { recursive: true })
      if (plist) await writeFile(join(root, n, 'Contents/Info.plist'), plist)
    }
    await mk(
      'Foo.app',
      `<?xml version="1.0"?><plist><dict><key>CFBundleDisplayName</key><string>Foo &amp; Co</string><key>CFBundleIdentifier</key><string>com.example.foo</string></dict></plist>`,
    )
    await mk('Agent.app', `<plist><dict><key>LSUIElement</key><string>1</string></dict></plist>`)
    await mk(
      'FooCopy.app',
      `<plist><dict><key>CFBundleIdentifier</key><string>com.example.foo</string></dict></plist>`,
    )
    await mk('NoPlist.app')
    await writeFile(join(root, 'readme.txt'), 'x')
    const apps = await discoverMac({ dirs: [root, join(tmp, 'missing')] })
    expect(apps.map((a) => a.name).sort()).toEqual(['Foo & Co', 'NoPlist'])
    const foo = apps.find((a) => a.name === 'Foo & Co')!
    expect(foo.launch).toEqual({ file: 'open', args: [join(root, 'Foo.app')] })
    expect(parsePlistXml('<key>A</key><string>b</string>')).toEqual({ A: 'b' })
  })
})

describe('windows', () => {
  it('lists .lnk files (skipping uninstallers) and UWP apps; paths with spaces stay one arg', async () => {
    const root = join(tmp, 'Start Menu', 'Programs')
    await mkdir(join(root, 'Dev Tools'), { recursive: true })
    await writeFile(join(root, 'Dev Tools', 'Code Editor.lnk'), '')
    await writeFile(join(root, 'Uninstall Thing.lnk'), '')
    const uwp = JSON.stringify([
      { Name: 'Calculator', AppID: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
      { Name: 'Code Editor', AppID: 'C:\\x\\code.exe' },
    ])
    const apps = await discoverWindows({ dirs: [root], getStartApps: async () => uwp })
    expect(apps.map((a) => a.name).sort()).toEqual(['Calculator', 'Code Editor'])
    const lnk = apps.find((a) => a.name === 'Code Editor')!
    expect(lnk.launch.args).toHaveLength(1)
    expect(lnk.launch.args[0]).toContain('Dev Tools')
    expect(apps.find((a) => a.name === 'Calculator')!.launch.args[0]).toBe(
      'shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',
    )
    expect(parseStartApps('not json')).toEqual([])
    expect(parseStartApps('{"Name":"A","AppID":"b!c"}')).toEqual([{ name: 'A', appId: 'b!c' }])
  })
})

describe('launch', () => {
  it('passes argv without a shell', async () => {
    const marker = join(tmp, 'pwn')
    await expect(
      launch({
        file: process.execPath,
        args: ['-e', 'process.exit(0)', `; touch ${marker}`, '&& echo x'],
      }),
    ).resolves.toBeUndefined()
    await new Promise((r) => setTimeout(r, 200))
    await expect(import('node:fs/promises').then((f) => f.access(marker))).rejects.toThrow()
  })
  it('rejects for missing binaries', async () => {
    await expect(launch({ file: join(tmp, 'nope'), args: [] })).rejects.toThrow()
  })
})

describe('AppsProvider + incremental refresh', () => {
  it('searches and replaces a single source', async () => {
    const p = new AppsProvider()
    const mkApp = (name: string, source: string) => ({
      id: name,
      name,
      keywords: [],
      launch: { file: name, args: [] },
      source,
      actions: [],
    })
    p.setAll([mkApp('Firefox', 'A'), mkApp('Safari', 'B')])
    const engine = new SearchEngine()
    engine.register(p)
    const run = async (q: string) => {
      const ids: string[] = []
      await engine.search(q, (b) => ids.push(...b.items.map((i) => i.title)))
      return ids
    }
    expect(await run('fire')).toEqual(['Firefox'])
    p.replaceSource('A', [mkApp('Firefox Developer', 'A')])
    expect(await run('fire')).toEqual(['Firefox Developer'])
    expect(await run('saf')).toEqual(['Safari'])
  })
  it('watcher reports changes in a root', async () => {
    const root = join(tmp, 'watch')
    await mkdir(root, { recursive: true })
    let closer: (() => Promise<void>) | undefined
    const changed = new Promise<string>((res) => {
      closer = watchRoots([root], res, 50)
    })
    await new Promise((r) => setTimeout(r, 300))
    await writeFile(join(root, 'new.desktop'), 'x')
    expect(await changed).toBe(root)
    await closer?.()
  })
})
