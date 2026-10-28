# Performance (§2 targets)

Measured with `BEACON_SMOKE=1 npx electron apps/desktop` (dev build, Electron 45) and `npm run bench`.
Numbers are from one machine; other OSes are pending CI runs.

| Metric                                   | Target              | macOS (Apple, 166 apps)                                                                                                              |
| ---------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Hotkey → painted frame                   | < 60 ms warm        | p50 ≈ 33 ms (n=11)                                                                                                                   |
| Keystroke → results committed to DOM     | < 16 ms             | p50 ≈ 4 ms, max ≈ 6 ms (n=20)                                                                                                        |
| Keystroke → next painted frame           | < 16 ms of app work | p50 ≈ 12 ms, max ≈ 21 ms (n=20); = commit + wait for next vsync (0–16.7 ms at 60 Hz), so it is bounded by the display, not by Beacon |
| Query over 50k items (worker core, Node) | p95 < 16 ms         | p95 ≈ 11 ms                                                                                                                          |
| Cold start → tray-resident               | < 2 s               | ≈ 0.65–0.9 s                                                                                                                         |
| App index (background, utilityProcess)   | n/a                 | 2.3–4.4 s for 166 apps (search usable meanwhile)                                                                                     |
| Idle memory (private/physical footprint) | < ~200 MB           | ≈ 170 MB (`npm run measure:memory`)                                                                                                  |

Idle memory is measured as physical footprint (macOS `footprint`, Linux Pss, Windows private bytes) summed over the process tree. Summed `workingSetSize` (~500 MB) double-counts pages shared between Electron processes and is not a fair figure. Footprint breakdown on macOS: main ≈ 54 MB, search worker ≈ 43 MB, renderer ≈ 31 MB, GPU ≈ 25 MB, network ≈ 7 MB, crashpad ≈ 3 MB.

## Known gaps

- Hotkey→visible uses a synthetic call to `showLauncher()`, not an OS key event.
- Windows and Linux numbers are pending CI runs.

## Files index (M6)

- Default: up to 100k entries under the configured roots (Home by default), throttled breadth-first crawl in a **short-lived child process** that writes a snapshot to the cache dir and exits; the search worker only loads the snapshot. (Crawling inside the long-lived worker left ~100 MB of freed-but-retained memory; the child process avoids it.)
- Search over the index is memory-lean (`searchLean`, no per-item prepared state) and time-boxed to 60 ms, so a huge index never blocks the worker. Cost: ~12 ms p50 / 30 ms max per query at 50k synthetic names (`npx tsx packages/core/bench/lean.ts`), slower than the prepared apps index (11 ms p95 at 50k) — file results arrive after fast providers, they never delay them.
- Idle footprint on macOS with a 100k-file index: ≈ 198 MB (≈ 179 MB with no file index). Memory grows roughly 0.2 MB per 1k files.
- The global (no-trigger) file search needs ≥ 3 characters; `f <text>` searches from 1.
