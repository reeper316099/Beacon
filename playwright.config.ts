import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1, // one Electron app at a time (it holds a single-instance lock per data dir)
  fullyParallel: false,
  reporter: [['list']],
  retries: process.env['CI'] ? 1 : 0,
})
