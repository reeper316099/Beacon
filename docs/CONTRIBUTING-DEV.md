# Developer guide

## Setup

```bash
npm install
npm run dev          # electron-vite dev: launcher + settings with hot reload
npm test             # Vitest (unit + property tests)
npm run lint && npm run typecheck && npm run guard
npm run bench        # 50k-item query latency (budget p95 < 16 ms)
npm run e2e          # Playwright on the built bundle (npm run build -w @beacon/desktop first)
npm run pack         # unpacked app in apps/desktop/release; set BEACON_E2E_BIN to run e2e against it
npm run dist         # installers for the current OS
```

Node 22+. No native modules are used; keep it that way (they wreck cross-OS packaging). If one is ever unavoidable, isolate it behind an adapter with a fallback.

## Conventions

- TypeScript strict. Workspace packages ship TS source and are bundled into the app by electron-vite.
- **Never** execute shell strings: `spawn(file, argv)`; arguments are data. `eval` / `new Function` are lint errors.
- Logs must not contain queries, clipboard contents, file names or note text.
- Tests use synthetic fixtures only. Per-OS adapters get fake `.desktop` trees, `.app` bundles, `places.sqlite` files, etc.
- Frecency/time logic takes an injected clock. Provider tests use a fake `Effects`.
- No personal data in the repo: `npm run guard` (also in CI) fails on home paths, keys, tracked `private-fixtures/` files, and on any string in your untracked `.git/guard-deny.txt`.

## End-to-end tests

`e2e/` drives the **packaged** app. `BEACON_E2E=1` swaps "open" effects and app launches for a JSONL log, `BEACON_APPS_FIXTURE` supplies fake apps, `BEACON_DATA_DIR` / `BEACON_CACHE_DIR` isolate state. `SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.ts` regenerates `docs/screenshots` from synthetic data.

## Releasing

1. Update `docs/RELEASE_NOTES.md` and the version in `package.json` / `apps/desktop/package.json`.
2. `git tag v1.0.3 && git push --tags`. The **Release** workflow builds Windows (NSIS + portable), macOS (universal dmg) and Linux (AppImage, deb, rpm), then publishes a GitHub release with SHA-256 sums. Builds are **unsigned** (see `docs/PLATFORMS.md`).
3. The **Nightly** workflow enforces the performance budgets (`docs/PERFORMANCE.md`).
