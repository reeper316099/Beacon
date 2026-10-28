# Beacon

A local-first, keyboard-first command bar for Windows, macOS and Linux. MIT licensed. No telemetry, no accounts, no network calls.

Status: M0–M8 done (core engine, apps, launcher shell, built-in providers, clipboard/snippets/notes, files/bookmarks/SSH, hub for the sibling apps, scripts/workflows/extensions/CLI). Docs: `docs/SCRIPTS.md`, `docs/EXTENSIONS.md`, `docs/INTEGRATIONS.md`, `docs/PLATFORMS.md`, `docs/PRIVACY.md`, `docs/PERFORMANCE.md`.

```bash
npm install
npm test          # matcher + core tests
npm run bench     # 50k-item query latency (budget: p95 < 16 ms)
```

```bash
npm run dev      # launch the app (electron-vite)
npm run build    # production bundles in apps/desktop/out
```
