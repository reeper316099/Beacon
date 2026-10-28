# Platform notes

## Global shortcut

Default `Alt+Space` (Option+Space on macOS), changeable in Settings. If registration fails (another app owns it) Beacon says so and suggests an alternative.

### Wayland

`globalShortcut` generally does not work on Wayland. Beacon detects Wayland (`XDG_SESSION_TYPE=wayland` / `WAYLAND_DISPLAY`), turns on Chromium's opt-in `GlobalShortcutsPortal` feature and tries to register. Support depends on your compositor and portal version and is unverified. If it fails, bind a shortcut in your desktop to the CLI:

```bash
beacon toggle
```

- GNOME: Settings → Keyboard → Custom Shortcuts → command `beacon toggle`.
- KDE: System Settings → Shortcuts → Add Command.
- Sway: `bindsym Alt+space exec beacon toggle`
- Hyprland: `bind = ALT, SPACE, exec, beacon toggle`

The CLI reads `<dataDir>/runtime/api.json` (port + per-launch token, mode 0600) and calls the loopback API.

## Window effects

macOS: vibrancy. Windows 11: acrylic. Linux: no blur API in Electron; glass is off by default (solid themed surface). Turn it on in Settings if your compositor supports transparency.

## Wayland window shadow

Frameless windows get GTK shadows on Wayland; Beacon sets `hasShadow: false` there.

## macOS permissions

Indexing Home touches Desktop/Documents/Downloads; macOS asks for permission the first time and blocks that folder's read until you answer (we read a few folders at once so the rest of the crawl continues). Grant it, or remove those roots in `config/files.json`.

## Files: external sources

`config/files.json` → `"source"`: `builtin` (default), `spotlight` (macOS `mdfind -name`), `everything` (Windows `es.exe`), `locate` (`plocate`/`locate`). Queries are passed as a single argv element.

## Bookmarks

Opt-in per profile via `bm ` (nothing is read until you enable a profile). Chromium-family (Chrome, Edge, Brave, Vivaldi, Chromium) read the Bookmarks JSON. Firefox's `places.sqlite` is copied to a temp dir and read with a pure-WASM sqlite; recent bookmarks still in Firefox's write-ahead log may not appear until Firefox checkpoints. No history is read.

## SSH

`ssh ` lists hosts from `~/.ssh/config` (Include supported; wildcard hosts ignored). Connecting opens a terminal with `ssh <alias>` (argv; on macOS via Terminal + AppleScript with the alias strictly validated). Set `config/terminal.json` → `{"command": ["kitty"]}` to use another terminal. Private keys are never read.

## Installing (unsigned builds)

Release builds are **not code-signed** yet. Expect these one-time prompts:

- **Windows**: SmartScreen shows "Windows protected your PC" → _More info_ → _Run anyway_. Antivirus products occasionally flag unsigned Electron apps; the build is reproducible from source and SHA-256 sums are published with each release.
- **macOS**: Gatekeeper blocks the first launch. Right-click the app → _Open_, or run `xattr -dr com.apple.quarantine /Applications/Beacon.app`. Beacon is a menu-bar app (no Dock icon). macOS may ask for Accessibility permission only if you enable optional features that need it (paste-to-previous-app is not enabled in v0.1).
- **Linux**: AppImage needs `chmod +x`; `.deb`/`.rpm` install normally. On Wayland follow the shortcut section above.

### Adding signing later

- **Windows**: set `CSC_LINK` (a .pfx, base64) and `CSC_KEY_PASSWORD` as repository secrets and remove `CSC_IDENTITY_AUTO_DISCOVERY: false` in `.github/workflows/release.yml`; electron-builder signs NSIS + portable.
- **macOS**: remove `identity: null` and set `hardenedRuntime: true` in `apps/desktop/electron-builder.yml`, add `CSC_LINK`/`CSC_KEY_PASSWORD` (Developer ID Application certificate) and notarization secrets (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), and add `notarize: true` under `mac:`.
- **Linux**: optionally GPG-sign the checksums file.

## Launch at login and tray

Tray / menu-bar icon: Show, Pause clipboard history, Settings, Run setup again, Quit. "Launch at login" is a setting; macOS may refuse it for unsigned apps (harmless, logged once).
