# Privacy

Beacon makes no network calls, has no accounts and no telemetry. Everything below stays on this machine.

## What is stored (in the data dir)

| Data                                        | File                                                           | Notes                                            |
| ------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| Settings                                    | `config/settings.json`                                         |                                                  |
| Frecency (what you launch, per typed query) | `data/frecency/frecency.json`                                  | Remove one item with Ctrl+Backspace              |
| Clipboard history                           | `data/clipboard/history.jsonl`, `images/`                      | 7 days / 500 items by default, pinned items kept |
| Snippets, notes, todos                      | `data/snippets                                                 | notes                                            | todos/` |     |
| Pins, aliases, item hotkeys                 | `data/pins.json`, `config/aliases.json`, `config/hotkeys.json` |                                                  |
| Timers                                      | `data/timers.json`                                             |                                                  |
| Local API token                             | `runtime/api.json`                                             | Mode 0600, regenerated each launch               |

Logs never contain queries, clipboard contents, file names or note text.

## Clipboard history rules

- Opt-out via the tray item “Pause clipboard history”.
- Clipboard results are `sensitive`: they never appear in the default list, only after the `cb ` trigger.
- Not recorded: copies flagged concealed/transient by the OS or password managers (macOS `org.nspasteboard.*`, Windows `ExcludeClipboardContentFromMonitorProcessing`, KDE `x-kde-passwordManagerHint`), text over 1 MB, images over 5 MB, and anything matching `ignore` regexes in `config/clipboard.json`.
- Whatever was on the clipboard when Beacon started is not recorded.
- `cb wipe` deletes all history and image files.
- Not yet implemented: encryption at rest; excluding copies by source application (needs native APIs).
