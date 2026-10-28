// Generates docs/screenshots/*.png from demo (synthetic) data only. Run: SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.ts
import { test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { launchBeacon, sleep } from './helpers'

test.skip(!process.env['SCREENSHOTS'], 'set SCREENSHOTS=1 to regenerate docs/screenshots')

test('screenshots', async () => {
  const out = resolve(import.meta.dirname, '../docs/screenshots')
  await mkdir(out, { recursive: true })
  const b = await launchBeacon({ seed: true })
  try {
    await writeFile(join(b.dataDir, 'scripts-demo.txt'), '')
    const page = await b.launcher()
    const input = page.getByRole('combobox', { name: 'Search' })
    const shot = async (name: string, prep?: () => Promise<unknown>) => {
      await sleep(500)
      await prep?.() // after results have settled, so nothing re-renders over it
      await writeFile(join(out, name), await page.screenshot())
    }
    await b.api('show')
    await input.fill('fire')
    await sleep(400)
    await shot('launcher-apps.png')
    await input.fill('15% of 240')
    await shot('launcher-calculator.png')
    await input.fill('uuid')
    // The command is random by design; show an obvious placeholder instead of a real-looking value.
    await page.waitForFunction(() => /[0-9a-f]{8}-[0-9a-f]{4}-/.test(document.body.innerText))
    await shot('launcher-dev-utils.png', () =>
      page.evaluate(() => {
        // Titles are rendered as one text node per character (match highlighting), so work per element.
        const re = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/
        document.querySelectorAll('.row .title').forEach((el) => {
          if (re.test(el.textContent ?? '')) el.textContent = '00000000-0000-4000-8000-000000000000'
        })
      }),
    )
    await input.fill('timer 25m focus')
    await shot('launcher-timer.png')
  } finally {
    await b.close()
  }
})
