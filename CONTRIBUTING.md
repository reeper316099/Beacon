# Contributing

- `npm install`, then `npm test`, `npm run lint`, `npm run typecheck`, `npm run bench`.
- Keep Beacon local-first: no telemetry, no network calls, no shell-string execution (`spawn(file, argv)` only).
- Never commit personal data. Fixtures must be synthetic; `npm run guard` runs in CI.
- Do not copy the look, wording, icons or APIs of other launchers.
