# Integrations: Lorekeeper, Cipherkeep, Worldloom, Classpad

Beacon reads these apps' data folders **read-only** and can open them. Every adapter is **off until you enable it**:
type `hub` in the launcher, pick "Enable <App>" (it asks first; the detected folder is shown). Nothing is read before that.
Data folders are auto-detected (`LOREKEEPER_DATA_DIR`, `CIPHERKEEP_DATA_DIR`, `WORLDLOOM_DATA_DIR`, `CLASSPAD_DATA_DIR`, else the
OS app-data folder) and can be overridden with `dir` in `config/integrations.json`.

| App        | Triggers        | What shows                                                                                      | Primary action                                                                              |
| ---------- | --------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Lorekeeper | `lk `, `lore `  | titles (+ alt titles), status, progress, the "left off" bookmark (preview)                      | open title                                                                                  |
| Cipherkeep | `cmd `, `ck `   | commands, concepts, lab titles/status                                                           | **copy syntax** (example / name / open as secondary actions); preview shows the explanation |
| Worldloom  | `wl `, `wiki `  | page titles + aliases, spoiler-safe (below)                                                     | open page                                                                                   |
| Classpad   | `cp `, `class ` | today's and overdue deadlines (empty state), assignments due within 21 days, tasks, note titles | open item                                                                                   |

Matches also contribute to the default list (weight 0.9). The empty state shows today's/overdue Classpad deadlines and a
"My apps" row for whichever of the four apps are installed.

## Safety guarantees

- **Spoilers (Worldloom).** A page is included only if it has no `reveal` gate, or the gate is satisfied by that world's saved
  progress (same rules as Worldloom: source position, arc checkpoint, implied floors; unknown/invalid gate = hidden). Gated pages are
  never read into Beacon: titles, aliases and bodies cannot leak. Page bodies are never included for any page. `dmOnly` pages and
  redirect pages are skipped. If `world.json` is missing/invalid, the world is skipped (progress unknown). Worldloom's own
  `showAll` / "revealed" flags are deliberately **not** honoured; Beacon has its own explicit switch (`hub` → Worldloom → "Show spoilers",
  off by default, asks for confirmation). Pinned items and aliases are snapshots: if you later move your progress backwards, unpin them.
- **Grades (Classpad).** Only `id`, `title`, `classId`, `status` and `due` are copied out of assignments; scores, weights, points,
  quick notes and grading schemes are never kept. Note bodies are never read, only titles. Classpad's "hide grades" is UI state and
  not detectable on disk, so grades are always excluded. Encrypted collections are skipped (Beacon never asks for a passphrase).
- **Cipherkeep.** Lab write-ups and flags are never read. If vault encryption is on, the whole adapter is skipped.
- **Read-only.** Adapters never write. Schema newer than expected → that file is skipped with a warning (`hub` shows the count);
  corrupt files are skipped; nothing crashes.
- Tests: `packages/providers/test/hub.test.ts` seeds gated pages / grades / write-ups with marker strings and fails if any appear in
  results, previews, warnings or console output (with a control test showing the check can fail).

## Deep links (for you to add to the apps)

Beacon emits these; the apps don't handle them yet. Until `deepLinks` is `true` for an app (`hub` → app → action) "Open" just launches
the app (macOS `open -a`); every item also has "Copy deep link" and "Try <scheme>:// link".

| App        | URL                                                                            |
| ---------- | ------------------------------------------------------------------------------ |
| Lorekeeper | `lorekeeper://open?id=<entry id>`                                              |
| Cipherkeep | `cipherkeep://open?type=command\|concept\|lab&id=<ulid>`                       |
| Worldloom  | `worldloom://open?world=<world slug>&page=<page slug>`                         |
| Classpad   | `classpad://open?type=assignment\|task\|note&id=<ulid>`                        |
| Beacon     | `beacon://toggle`, `beacon://show`, `beacon://hide`, `beacon://query?q=<text>` |

Each app would call `app.setAsDefaultProtocolClient('<scheme>')`, handle `open-url` (macOS) and `second-instance` argv (Windows/Linux),
then route. Beacon only ever opens these five schemes.

## Source Adapter contract (v1)

`packages/providers/src/hub/types.ts`. An adapter is `{ contractVersion: 1, id, name, scheme, triggers, dataDirEnv, folderName,
load(dir, { now, showSpoilers }) => { items, warnings } }`. Rules: read-only; never throw on odd data (skip + warn); tolerate newer
schema versions (skip that file); whatever must stay hidden must not be in `items` (Beacon does no further filtering); warnings must
not contain item content. Items carry a primary action, optional secondary actions and an optional Markdown/text preview.
The same shape can be implemented as an extension (M8): return the items from a `Provider.query`.
