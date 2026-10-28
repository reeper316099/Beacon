/* eslint-disable @typescript-eslint/no-explicit-any -- test helper returns loosely typed JSON */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export interface Beacon {
  app: ElectronApplication
  dataDir: string
  cacheDir: string
  launcher(): Promise<Page>
  window(hash: string): Promise<Page>
  api(path: string, method?: 'GET' | 'POST', body?: unknown): Promise<any>
  actions(): Promise<Record<string, any>[]>
  clipboard(): Promise<string>
  close(): Promise<void>
}

const ROOT = resolve(import.meta.dirname, '..')
const apps = [
  {
    id: 'fx-firefox',
    name: 'Firefox',
    keywords: [],
    launch: { file: '/usr/bin/firefox-e2e', args: ['--e2e'] },
    source: 'fixture',
    actions: [
      {
        id: 'private',
        title: 'New Private Window',
        launch: { file: '/usr/bin/firefox-e2e', args: ['--private'] },
      },
    ],
  },
  {
    id: 'fx-safari',
    name: 'Safari',
    keywords: [],
    launch: { file: '/usr/bin/safari-e2e', args: [] },
    source: 'fixture',
    actions: [],
  },
  {
    id: 'fx-terminal',
    name: 'Terminal',
    keywords: ['shell', 'console'],
    launch: { file: '/usr/bin/terminal-e2e', args: [] },
    source: 'fixture',
    actions: [],
  },
]

/** Launch Beacon against fresh (or supplied) data/cache dirs. `seed: true` skips onboarding and disables hide-on-blur. */
export async function launchBeacon(
  opts: { dataDir?: string; cacheDir?: string; seed?: boolean } = {},
): Promise<Beacon> {
  const base = opts.dataDir ? undefined : await mkdtemp(join(tmpdir(), 'beacon-e2e-'))
  const dataDir = opts.dataDir ?? join(base as string, 'data')
  const cacheDir = opts.cacheDir ?? join(base ?? dataDir, 'cache')
  await mkdir(join(dataDir, 'config'), { recursive: true })
  await mkdir(join(dataDir, 'runtime'), { recursive: true })
  const fixture = join(dataDir, 'apps-fixture.json')
  await writeFile(fixture, JSON.stringify(apps))
  if (opts.seed !== false && opts.seed !== undefined)
    await writeFile(
      join(dataDir, 'config/settings.json'),
      JSON.stringify({
        onboarded: true,
        hideOnBlur: false,
        hotkey: 'Ctrl+Alt+Shift+F12',
        theme: 'dark',
      }),
    )
  // Keep the file index out of the way: a tiny temp root instead of the real home directory.
  const roots = join(dataDir, 'roots')
  await mkdir(roots, { recursive: true })
  await writeFile(join(roots, 'e2e-needle-file.txt'), 'hello')
  await writeFile(join(dataDir, 'config/files.json'), JSON.stringify({ roots: [roots] }))

  const log = join(dataDir, 'runtime/e2e-actions.jsonl')
  const bin = process.env['BEACON_E2E_BIN']
  const app = await electron.launch({
    ...(bin ? { executablePath: bin, args: [] } : { args: [join(ROOT, 'apps/desktop')] }),
    // CI containers need --no-sandbox for Chromium
    ...(process.env['CI'] && process.platform === 'linux'
      ? { args: [...(bin ? [] : [join(ROOT, 'apps/desktop')]), '--no-sandbox'] }
      : {}),
    env: {
      ...process.env,
      BEACON_DATA_DIR: dataDir,
      BEACON_CACHE_DIR: cacheDir,
      BEACON_E2E: '1',
      BEACON_E2E_LOG: log,
      BEACON_APPS_FIXTURE: fixture,
    } as Record<string, string>,
  })

  const windows = async (hash: string): Promise<Page> => {
    for (let i = 0; i < 100; i++) {
      for (const w of app.windows()) {
        const u = w.url()
        if (hash === '' ? u && !u.includes('#') : u.endsWith('#' + hash)) return w
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`window #${hash} not found`)
  }
  const apiInfo = async () => {
    for (let i = 0; i < 100; i++) {
      try {
        return JSON.parse(await readFile(join(dataDir, 'runtime/api.json'), 'utf8')) as {
          port: number
          token: string
        }
      } catch {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    throw new Error('api.json never appeared')
  }
  return {
    app,
    dataDir,
    cacheDir,
    launcher: () => windows(''),
    window: windows,
    async api(path, method = 'POST', body) {
      const a = await apiInfo()
      const r = await fetch(`http://127.0.0.1:${a.port}/v1/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${a.token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      return r.json()
    },
    async actions() {
      try {
        return (await readFile(log, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      } catch {
        return []
      }
    },
    clipboard: () => app.evaluate(({ clipboard }) => clipboard.readText()),
    async close() {
      await app.close().catch(() => {})
      if (base) await rm(base, { recursive: true, force: true })
    },
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
