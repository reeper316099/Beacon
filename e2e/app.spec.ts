import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBeacon, sleep } from './helpers'

test.describe('Beacon end to end', () => {
  test('first run: onboarding walks through setup and remembers it', async () => {
    const b = await launchBeacon({ seed: undefined })
    try {
      const ob = await b.window('onboarding')
      await expect(ob.getByRole('heading', { name: 'Welcome to Beacon' })).toBeVisible()
      await expect(ob.getByRole('heading', { name: 'Pick your shortcut' })).toBeVisible()
      await ob.getByRole('button', { name: 'Next' }).click()
      await expect(ob.getByRole('heading', { name: /Where should Beacon look/ })).toBeVisible()
      await ob.getByRole('button', { name: 'Next' }).click()
      await expect(ob.getByRole('heading', { name: /Choose what Beacon can do/ })).toBeVisible()
      await expect(ob.getByLabel(/Calculator/)).toBeVisible()
      await ob.getByRole('button', { name: 'Next' }).click()
      await expect(ob.getByRole('heading', { name: /Connect your apps/ })).toBeVisible()
      await ob.getByRole('button', { name: 'Next' }).click()
      await expect(ob.getByRole('heading', { name: /Try it/ })).toBeVisible()
      // the tour notices the launcher being summoned (via the CLI-equivalent API)
      await b.api('show')
      await expect(ob.getByText(/✓ .*to open Beacon/)).toBeVisible()
      await ob.getByRole('button', { name: 'Finish' }).click()
      await expect
        .poll(async () => {
          try {
            return JSON.parse(await readFile(join(b.dataDir, 'config/settings.json'), 'utf8'))
              .onboarded
          } catch {
            return false // not written yet
          }
        })
        .toBe(true)
    } finally {
      await b.close()
    }
  })

  test('summon, find an app and launch it (mock launcher), calculator, snippet, clipboard, alias and pin', async () => {
    const b = await launchBeacon({ seed: true })
    try {
      const page = await b.launcher()
      const input = page.getByRole('combobox', { name: 'Search' })
      const options = page.getByRole('option')

      await b.api('show')
      await input.fill('fire')
      await expect(options.first()).toContainText('Firefox')
      await input.press('Enter')
      await expect
        .poll(async () => (await b.actions()).find((a) => a['kind'] === 'launch')?.['file'])
        .toBe('/usr/bin/firefox-e2e')

      // file index: crawled in a child process, then searchable
      await b.api('show')
      await expect
        .poll(async () => {
          await input.fill('')
          await input.fill('e2e-needle')
          await sleep(300)
          return await options.filter({ hasText: 'e2e-needle-file.txt' }).count()
        })
        .toBeGreaterThan(0)

      await b.api('show')
      await input.fill('23*1.08')
      await expect(options.first()).toContainText('24.84')
      await input.press('Enter')
      await expect.poll(() => b.clipboard()).toBe('24.84')

      await b.api('show')
      await input.fill('snip new Sig :: Hello {date:YYYY}')
      await expect(options.first()).toContainText('Create snippet')
      await input.press('Enter')
      await sleep(300)
      await b.api('show')
      await input.fill('snip sig')
      await expect(options.first()).toContainText('Sig')
      await input.press('Enter')
      await expect.poll(() => b.clipboard()).toMatch(/^Hello 20\d\d$/)

      // clipboard history: copy something outside Beacon, then search for it behind the `cb ` trigger
      await sleep(1500) // let the clipboard watcher take its baseline
      await b.app.evaluate(({ clipboard }) => clipboard.writeText('e2e-clipboard-marker-123'))
      await b.api('show')
      await expect
        .poll(async () => {
          await input.fill('')
          await input.fill('cb e2e-clipboard')
          await sleep(250)
          return await options.count()
        })
        .toBeGreaterThan(0)
      await expect(options.first()).toContainText('e2e-clipboard-marker-123')
      // ...and it never shows up in the default (no-trigger) list
      await input.fill('e2e-clipboard-marker')
      await sleep(400)
      await expect(page.getByText('e2e-clipboard-marker-123')).toHaveCount(0)

      // alias + pin
      await input.fill('alias ff firefox')
      await expect(options.first()).toContainText('Alias')
      await input.press('Enter')
      await sleep(300)
      await b.api('show')
      await input.fill('ff')
      await expect(options.first()).toContainText('Firefox')
      await expect(options.first()).toContainText('Alias')
      await input.fill('safa')
      await expect(options.first()).toContainText('Safari')
      await input.press('Control+p')
      await expect(page.getByRole('status').filter({ hasText: 'Pinned' })).toBeVisible()
      await input.fill('')
      await expect(page.getByRole('option', { name: /Safari/ })).toBeVisible()
    } finally {
      await b.close()
    }
  })

  test('settings and history persist across a restart', async () => {
    const first = await launchBeacon({ seed: true })
    const { dataDir, cacheDir } = first
    try {
      const page = await first.launcher()
      await first.api('show')
      await page.getByRole('combobox', { name: 'Search' }).fill('terminal')
      await expect(page.getByRole('option').first()).toContainText('Terminal')
      await page.getByRole('combobox', { name: 'Search' }).press('Enter')
      await page.evaluate(() => window.beacon.openSettings())
      const settings = await first.window('settings')
      await expect(settings.getByRole('heading', { name: 'Settings' })).toBeVisible()
      await settings.getByLabel('Theme').selectOption('light')
      await settings.getByLabel('High contrast').click()
      await expect(settings.getByLabel('High contrast')).toBeChecked()
      await expect
        .poll(
          async () =>
            JSON.parse(await readFile(join(dataDir, 'config/settings.json'), 'utf8')).theme,
        )
        .toBe('light')
      await sleep(3800) // frecency is flushed every 3 s
    } finally {
      await first.app.close().catch(() => {})
    }

    const second = await launchBeacon({ dataDir, cacheDir })
    try {
      const page = await second.launcher()
      expect(
        await page.evaluate(() =>
          window.beacon.getSettings().then((s) => [s.theme, s.highContrast]),
        ),
      ).toEqual(['light', true])
      await second.api('show')
      await page.getByRole('combobox', { name: 'Search' }).fill('')
      await expect(page.getByRole('option', { name: /Terminal/ })).toBeVisible() // recents come from persisted frecency
    } finally {
      await second.close()
    }
  })

  test('accessibility: launcher and settings have no serious axe violations', async () => {
    const b = await launchBeacon({ seed: true })
    try {
      const page = await b.launcher()
      await b.api('show')
      await page.getByRole('combobox', { name: 'Search' }).fill('fire')
      await expect(page.getByRole('option').first()).toBeVisible()
      const r = await new AxeBuilder({ page }).setLegacyMode(true).analyze()
      console.log(
        `axe launcher: ${r.passes.length} rules passed, violations: ${r.violations.map((v) => `${v.id}(${v.impact})`).join(', ') || 'none'}`,
      )
      const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
      expect(bad.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 80)}`)).toEqual([])
      await page.evaluate(() => window.beacon.openSettings())
      const s = await b.window('settings')
      await expect(s.getByRole('heading', { name: 'Settings' })).toBeVisible()
      const r2 = await new AxeBuilder({ page: s }).setLegacyMode(true).analyze()
      expect(
        r2.violations
          .filter((v) => v.impact === 'serious' || v.impact === 'critical')
          .map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 80)}`),
      ).toEqual([])
    } finally {
      await b.close()
    }
  })

  test('performance: hotkey-equivalent show → visible, reported (budget enforced in the nightly job)', async ({
    browserName: _bn,
  }, info) => {
    void _bn
    const b = await launchBeacon({ seed: true })
    try {
      await b.launcher()
      for (let i = 0; i < 15; i++) {
        await b.api('show')
        await sleep(250)
        await b.api('hide')
        await sleep(120)
      }
      const st = await b.api('status', 'GET')
      const p50 = st.perf.hotkeyToVisibleMs.p50 as number
      info.annotations.push({ type: 'hotkeyToVisibleMs.p50', description: String(p50) })
      console.log(
        `hotkey→visible p50=${p50}ms (n=${st.perf.hotkeyToVisibleMs.n}) coldStart=${st.perf.coldStartMs}ms rss≈${st.perf.rssMB}MB`,
      )
      expect(st.perf.hotkeyToVisibleMs.n).toBeGreaterThan(5)
      const budget = Number(process.env['BEACON_BUDGET_SHOW_MS'] ?? 400) // generous by default; the nightly job sets 60
      expect(p50).toBeLessThan(budget)
    } finally {
      await b.close()
    }
  })

  test('CLI-equivalent API: toggle and query work; browser-style requests are rejected', async () => {
    const b = await launchBeacon({ seed: true })
    try {
      await b.launcher()
      expect((await b.api('toggle')).ok).toBe(true)
      const q = await b.api('query', 'POST', { text: 'term' })
      expect(q.items.some((i: { title: string }) => i.title === 'Terminal')).toBe(true)
      const info = JSON.parse(await readFile(join(b.dataDir, 'runtime/api.json'), 'utf8'))
      const noAuth = await fetch(`http://127.0.0.1:${info.port}/v1/status`)
      expect(noAuth.status).toBe(401)
      const withOrigin = await fetch(`http://127.0.0.1:${info.port}/v1/status`, {
        headers: { authorization: `Bearer ${info.token}`, origin: 'http://evil.example' },
      })
      expect(withOrigin.status).toBe(403)
    } finally {
      await b.close()
    }
  })
})
