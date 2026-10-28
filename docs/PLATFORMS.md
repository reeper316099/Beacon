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
