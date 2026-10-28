# Beacon

A local-first, keyboard-first command bar for Windows, macOS and Linux. MIT licensed. No telemetry, no accounts, no network calls.

Status: M0–M3 done (scaffold, core engine, app discovery, Electron shell). See `docs/PERFORMANCE.md` and `docs/PLATFORMS.md`.

```bash
npm install
npm test          # matcher + core tests
npm run bench     # 50k-item query latency (budget: p95 < 16 ms)
```

```bash
npm run dev      # launch the app (electron-vite)
npm run build    # production bundles in apps/desktop/out
```
