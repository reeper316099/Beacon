# Script Commands

Point Beacon at a folder and every script in it becomes a command. Output streams live inside the launcher.

## Setup

- The default folder is `<dataDir>/scripts`. Add more with `script add /path/to/folder` in the launcher or in `config/scripts.json`
  (`folders`: `[{ "path": "...", "interpreters": {".py": "/opt/venv/bin/python"}, "cwd": "...", "env": ["MY_VAR"], "extraPath": ["/opt/bin"] }]`).
- Subfolders become groups. Adding, editing or deleting files hot-reloads. `script new py|js|sh|ps1 <name>` scaffolds a template with a header.
- Recognized: `.py .js .mjs .cjs .ts .sh .bash .zsh .ps1 .bat .cmd .rb .pl`, plus any file with an executable bit and a `#!` line.
  The interpreter is the shebang if present, else your per-extension override, else auto-detected (`python3`/`python`/`py`, `node`,
  `bash`, `zsh`, `pwsh`/`powershell`, `ruby`, `perl`). `.ts` needs `"tsRunner": ["tsx"]`.

## Header (any comment style: `#`, `//`, `--`, `;`, `::`, `REM`, `/* */`)

```
# @beacon.title    Backup home lab
# @beacon.desc     Rsync configs to NAS
# @beacon.keyword  bk
# @beacon.icon     💾
# @beacon.output   inline | list | copy | silent | terminal      (default: inline)
# @beacon.arg      target:choice(nas,usb)=nas  "Where to?"
# @beacon.arg      note:text?  "Optional note"
# @beacon.timeout  60
# @beacon.confirm  true
# @beacon.os       linux,macos
# @beacon.ssh      home-lab            (run on a host from your ssh config)
# @beacon.save-output true             (opt in to keeping this script's output in run history)
```

No header? The filename is the title. Languages without comments can use a sidecar `script.beacon.json` with the same keys (`args` is a list of strings).
Arg types: `text number choice(...) file folder clipboard selection secret`; `?` = optional, `=value` = default. Type them after the keyword
(`bk nas "weekly"`) or fill the form. `secret` is prompted on every run and never stored, logged or re-used by re-run.

## Output modes

- **inline** (default): live stdout + stderr (stderr tinted), ANSI colours, auto-scroll, exit code + duration, copy all / copy last line,
  **Ctrl/⌘+R** re-run, **Esc / Ctrl+C** cancel (SIGTERM, then SIGKILL after 3 s; Windows kills the whole tree). 1 MB cap (configurable) with a
  notice. Scripts keep running if the launcher hides; the tray shows how many are running.
- **list**: print JSON Lines `{"title","subtitle","icon","value","action"}`; the text after the keyword is passed as the last argument and on stdin. Results
  update as you type (debounced, previous run is cancelled). `action`: `copy` (default) | `open` | `url` | `run:<keyword>`.
- **copy** (stdout → clipboard), **silent** (notification on non-zero exit), **terminal** (your terminal; macOS can't pass arguments).

## Safety

- Never a shell string: `spawn(file, argv)`; arguments are data (`;`, `&&`, quotes and spaces stay literal). `.bat/.cmd` on Windows re-parse arguments, so
  arguments containing `& | < > ^ % " ! ( )` are refused.
- **Trust on first use, per content hash.** The first run, and any run after the file changes, shows the path, interpreter and a preview (a diff when it
  changed) and needs your OK. Scripts are never run on discovery. `@beacon.confirm true` and `@beacon.ssh` ask every time.
- Minimal environment: `PATH HOME USER LANG TMPDIR…` plus your allow-list (`envAllow`, per-folder `env`); no Beacon variables or tokens.
- Default timeout 30 s (per script via `@beacon.timeout`), concurrency limit 4, optional working directory.
- Remote (`@beacon.ssh alias`): runs `ssh <alias> <interpreter> -s -- args` with the script piped over stdin; only aliases in your `~/.ssh/config`;
  every word is quoted for the remote shell; supports sh/bash/zsh, python and node.
- Privacy: output is held in memory only. Optional run history (`"history": true` → `data/script-runs/history.jsonl`) records time, script, exit code and duration;
  output only for scripts with `@beacon.save-output true`. Arguments and output are never logged.

## From the CLI and elsewhere

`beacon run <script> [-- args]` (name, keyword or path) runs a trusted script and prints its output (exit code propagated). Untrusted/changed scripts and
scripts that need confirmation or a secret are refused: run them once from the launcher. Scripts can be pinned, aliased, given a global hotkey, and used as
steps in workflows.

## beacon-sdk (optional helpers)

Print JSON Lines for list mode, and `@@beacon {json}` control lines (hidden from output) for notifications and progress. Helpers: `packages/sdk/script/beacon-sdk.mjs`
(Node), `packages/sdk/python/beacon_sdk.py`, `packages/sdk/shell/beacon-sdk.sh`:

```python
from beacon_sdk import emit, notify, progress
progress(0.4, "copying"); emit("Result", subtitle="detail", value="copied value"); notify("Done")
```
