# Architecture

Beacon is an Electron app (TypeScript everywhere) organised as an npm-workspaces monorepo. Everything is local: no telemetry, no accounts, no network calls.

```
                       ┌────────────────────────── main process ───────────────────────────┐
 global hotkey ───────▶│ window manager (hidden, warm launcher window)   tray   single-instance│
 beacon:// URLs        │ settings (JsonFile)   Fastify API 127.0.0.1 + token   clipboard poll │
 CLI (beacon …) ──────▶│ effects broker (clipboard, browser, notifications, hotkeys)          │
                       │ ExtensionManager ─────────────┐                                       │
                       └───────┬───────────────────────┼───────────────────────────────────────┘
                 MessagePort   │ (hot path bypasses main)│ utilityProcess per extension
        ┌───────────────┐      ▼                        ▼
        │ renderer      │◀────────────▶ ┌───────────────────────┐   ┌──────────────────────────┐
        │ React+zustand │   queries,    │ search worker         │   │ extension process        │
        │ virtual list  │   batches,    │ (utilityProcess)      │   │ QuickJS (WASM) sandbox,  │
        └───────────────┘   script      │ providers, ranking,   │   │ ctx.* → host-checked     │
                            events      │ frecency, indexes,    │   └──────────────────────────┘
                                        │ scripts, workflows    │   ┌──────────────────────────┐
                                        └──────────┬────────────┘   │ crawl child process      │
                                                   │ spawn(file,argv)│ (exits after indexing)   │
                                                   ▼                 └──────────────────────────┘
                                          scripts / programs
```

## Packages

| Package              | Purpose                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`    | `APP_NAME`, the Provider / ResultItem / Action contract (Zod), `Effects`                                                                        |
| `packages/matcher`   | fzf-style fuzzy scorer (boundary/camelCase/consecutive/prefix/acronym bonuses), lean search for big indexes                                     |
| `packages/core`      | query parser, frecency (decay), ranking, stable result list, `SearchEngine`, MessagePort protocol                                               |
| `packages/jsonstore` | atomic writes (tmp→fsync→rename), per-file queue, schema versions + migrations, corruption quarantine, rolling backups                          |
| `packages/apps`      | app discovery for Windows/macOS/Linux, launch, incremental refresh                                                                              |
| `packages/providers` | built-in providers (calculator, dev utils, clipboard, snippets, notes, files, bookmarks, SSH, hub adapters, scripts, workflows, extension host) |
| `packages/sdk`       | extension types, scaffold + dev runner, script helpers (Node/Python/shell)                                                                      |
| `apps/desktop`       | Electron main / preload / worker entries, React renderer, CLI, packaging                                                                        |

## The hot path

Keystroke → renderer → **MessagePort straight to the search worker** → providers run concurrently (each with a timeout and an `AbortSignal`) → results stream back **per provider** as they finish → the renderer merges them with `StableList`, which never reorders rows at or above the selection (late results append; a higher-scored duplicate upgrades its row in place). The main process is not on this path.
The launcher window is created hidden at startup and only ever shown/hidden (never rebuilt), so summon latency is a `show()` plus one frame.

## Why separate processes

- **Search worker** (utilityProcess): indexes and providers can't jank the UI.
- **Crawl child process**: crawling allocates a lot of garbage; a process that exits returns it to the OS (idle memory matters).
- **Extension process** per extension: crash isolation + watchdog; the code itself runs in a QuickJS WebAssembly sandbox (see `docs/EXTENSIONS.md`).

## Side effects

The worker never touches the clipboard, browser or notifications directly. It asks main (`Effects`), which performs a fixed set of operations with validation (http(s)-only URLs, allow-listed deep-link schemes, absolute paths). Programs are always `spawn(file, argv)`; there is no shell-string execution anywhere (an ESLint rule bans `eval`/`new Function`).

## Storage

`<dataDir>` (`%APPDATA%\Beacon`, `~/Library/Application Support/Beacon`, `$XDG_CONFIG_HOME|~/.config/Beacon`; override with `BEACON_DATA_DIR`) holds `config/` (hand-editable JSON), `data/`, `scripts/`, `workflows/`, `extensions/`, `backups/`. Indexes live in the OS cache dir. See `docs/PRIVACY.md`.

## Local API

Fastify on `127.0.0.1` (ephemeral port), per-launch bearer token in `runtime/api.json` (0600). Requests with an `Origin` header or a wrong `Host` are rejected (CSRF / DNS rebinding). Used by the CLI (`toggle|show|hide|status|reload|query|run`); not on the search hot path.
