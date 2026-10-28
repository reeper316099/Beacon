# Performance (§2 targets)

Measured with `BEACON_SMOKE=1 npx electron apps/desktop` (dev build, Electron 45) and `npm run bench`.
Numbers are from one machine; other OSes are pending CI runs.

| Metric                                   | Target       | macOS (Apple, 166 apps)                                                              |
| ---------------------------------------- | ------------ | ------------------------------------------------------------------------------------ |
| Hotkey → painted frame                   | < 60 ms warm | p50 ≈ 33 ms (n=11)                                                                   |
| Keystroke → results painted              | < 16 ms      | p50 ≈ 22 ms (n=4, includes worker round-trip + 1 frame; **over target, see below**)  |
| Query over 50k items (worker core, Node) | p95 < 16 ms  | p95 ≈ 11 ms                                                                          |
| Cold start → tray-resident               | < 2 s        | ≈ 0.65–0.9 s                                                                         |
| App index (background, utilityProcess)   | n/a          | 2.3–4.4 s for 166 apps (search usable meanwhile)                                     |
| Idle memory                              | < ~200 MB    | **≈ 490–530 MB** summed `workingSetSize` across Electron processes — **over target** |

## Known gaps

- Keystroke → paint includes one animation frame (~16 ms at 60 Hz) by construction in the current probe, so the metric is not comparable to the 16 ms budget until measured to "results committed" rather than "next frame". To be refined with a Playwright probe.
- Memory: `workingSetSize` double-counts shared pages across processes; real private footprint is lower but not yet measured. Candidates: single renderer already; check GPU/network helper processes and V8 flags.
- Hotkey→visible uses a synthetic call to `showLauncher()`, not an OS key event.
