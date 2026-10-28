# Providers

Everything searchable is a `Provider` (`packages/shared/src/index.ts`): built-ins, the sibling-app adapters, and extensions all use the same contract.

```ts
interface Provider {
  id: string
  name: string
  triggers?: string[] // e.g. "cb ", "snip ", "> "
  mode: 'global' | 'prefix-only' // global = contributes to the default list
  weight?: number
  timeoutMs?: number
  query(q: ParsedQuery, ctx, signal: AbortSignal): AsyncIterable<ResultItem> | Promise<ResultItem[]>
  activate?(itemId, actionId, ctx): Promise<void> // runs the action in the process that owns the provider
  forget?(itemId): void // Ctrl/Cmd+Backspace
}
```

`ParsedQuery` = trigger prefix, free text, `key:value` filters (`type:` `in:` `ext:` `app:`), and `command` + `args` after a trigger. The parser is a pure, tested function.

**Ranking** = match score × provider weight × frecency boost (decayed per-(query-prefix, item) selection history; half-life configurable; resettable). Ties are deterministic. Items flagged `sensitive` (clipboard) are never shown in the default list.

## Built-in providers

| Provider                        | Trigger / how                                          | Notes                                                                                      |
| ------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Apps                            | type a name                                            | Win Start Menu + UWP, macOS bundles, Linux `.desktop` (field codes, actions, Flatpak/Snap) |
| Files                           | 3+ chars, or `f `                                      | built-in index (100k default) or Spotlight / Everything / plocate; `ext: in: type:`        |
| Calculator                      | an expression                                          | math, units, bases, percent, date math, timezones; mathjs sandbox                          |
| Clipboard                       | `cb `                                                  | text + images, dedupe, retention, pin, exclusions; never in the default list               |
| Snippets / Notes / Todos        | `snip ` `note ` `todo `                                | placeholders `{clipboard} {date:…} {cursor} {prompt:x}`; `due:today`                       |
| Quicklinks                      | `g ` `yt ` `gh ` …                                     | opens the browser, never fetches                                                           |
| System, Processes               | `lock`, `kill `                                        | per-OS argv; destructive ones confirm                                                      |
| Bookmarks, SSH                  | `bm `, `ssh `                                          | opt-in per browser profile; argv-only terminal launch                                      |
| Emoji, Color, Dev utils, Timers | `emoji `, `#ff8800`, `uuid`/`hash`/`jwt`…, `timer 25m` | all offline                                                                                |
| My apps hub                     | `lk ` `cmd ` `wl ` `cp `                               | read-only adapters (`docs/INTEGRATIONS.md`)                                                |
| Scripts / Workflows             | your keywords                                          | `docs/SCRIPTS.md`, `docs/EXTENSIONS.md`                                                    |
| Extensions                      | their keywords                                         | sandboxed; `ext` to manage                                                                 |

Each provider can be switched off in Settings → Providers (or `config/providers.json` → `{"disabled": ["clipboard"]}`).

## Writing a provider

1. Implement the interface in `packages/providers/src/` (extend `LiveProvider` for computed results: it remembers the last results so `activate` can find the action).
2. Return `ResultItem`s with a primary `Action` (`copy`, `url`, `open`, `reveal`, `run`, `deeplink`, `custom`); mark anything dangerous `confirm: true`.
3. Register it in `apps/desktop/src/worker/search.ts`.
4. Test it with a `SearchEngine` and fake `Effects` (see `packages/providers/test/`). No test may touch the network, the real clipboard or the user's files.
