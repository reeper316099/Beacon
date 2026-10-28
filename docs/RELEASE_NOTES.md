# Beacon v1.0.3 (first release)

A local-first, keyboard-first command bar for Windows, macOS and Linux. No telemetry, no accounts, no network calls. **Builds are unsigned**: see "Installing (unsigned builds)" in `docs/PLATFORMS.md`.

## Highlights

- **Summon anywhere**: Alt+Space / Option+Space (changeable, conflicts reported), < 60 ms to a typeable bar; Wayland users get `beacon toggle` for their compositor's shortcut settings.
- **Apps, files, calculator** (math, units, percent, dates, timezones), **clipboard history** (private by default), **snippets, notes, todos, timers, emoji, color, dev utilities, quicklinks, system commands, processes, bookmarks, SSH hosts**.
- **Hub for your own apps**: read-only search of Lorekeeper, Cipherkeep (copy command syntax), Worldloom (spoiler-safe) and Classpad (deadlines; grades never shown).
- **Script Commands**: point at a folder; output streams live in the launcher, with trust-on-first-use per script version, cancel/re-run, list mode, secret arguments and optional ssh remote runs.
- **Workflows** (no code) and **sandboxed extensions** (QuickJS/WASM, default-deny permissions, crash watchdog).
- **CLI**: `beacon toggle|show|hide|status|reload|query|run`.
- Calm, glassy UI with light/dark/system themes, accent colour, high-contrast mode, screen-reader semantics and a first-run setup wizard.

## Downloads

Windows: NSIS installer and portable `.exe` · macOS: universal `.dmg` · Linux: AppImage, `.deb`, `.rpm`. Verify with `SHA256SUMS.txt`.

## Known limits

- Unsigned builds (SmartScreen / Gatekeeper prompts; some antivirus false positives).
- Wayland: global shortcuts depend on your compositor; use `beacon toggle`.
- Paste-into-previous-app, the window switcher and the XDG GlobalShortcuts portal are planned (M10), not in this release.
- Windows and Linux paths are covered by fixture tests and CI e2e; they have had less hands-on use than macOS.
- Clipboard history is not encrypted at rest yet.
- Worldloom/Classpad/Lorekeeper/Cipherkeep don't handle `lorekeeper://`-style deep links yet; "Open" launches the app (shapes documented in `docs/INTEGRATIONS.md`).
