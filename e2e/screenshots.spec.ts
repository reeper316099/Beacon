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
    const shot = async (name: string) => {
      await sleep(500)
      await writeFile(join(out, name), await page.screenshot())
    }
    await b.api('show')
    await input.fill('fire')
    await sleep(400)
    await shot('launcher-apps.png')
    await input.fill('15% of 240')
    await shot('launcher-calculator.png')
    await input.fill('uuid')
    await shot('launcher-dev-utils.png')
    await input.fill('timer 25m focus')
    await shot('launcher-timer.png')
  } finally {
    await b.close()
  }
})
