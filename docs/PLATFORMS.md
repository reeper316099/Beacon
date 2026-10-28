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
