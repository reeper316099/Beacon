# Extensions and workflows

## Workflows (no code)

A workflow is a JSON or YAML file in `<dataDir>/workflows/` (edit it in Settings → Workflows, or by hand):

```yaml
id: search-both
name: Search both
keyword: sb
args: [{ name: term, prompt: What? }]
steps:
  - kind: url # https/http only; values are URL-encoded
    url: https://example.com/?q={term}
  - kind: copy
    text: searched {term}
  - kind: run # program + argv, never a shell; asks to confirm every time
    file: git
    args: [status]
    os: [macos, linux] # optional OS filter
  - kind: wait
    ms: 500
  - kind: script # a trusted Script Command
    script: bk
```

Steps: `url open app copy run wait script`. `{name}`, `{query}` (all words typed) and `{clipboard}` are substituted as plain data. A failing step stops the run and names the step.

## Extensions (code)

A folder in `<dataDir>/extensions/<id>/` with `manifest.json` and a JS entry:

```json
{
  "id": "hello-ext",
  "name": "Hello",
  "version": "0.1.0",
  "apiVersion": 1,
  "main": "index.js",
  "commands": [{ "keyword": "hello", "title": "Say hello" }],
  "permissions": ["clipboard.write", "notifications"]
}
```

```js
module.exports = {
  async query(q, ctx) {
    return [
      {
        id: 'a',
        title: 'Hi ' + q.text,
        primary: { id: 'c', title: 'Copy', kind: 'copy', payload: { text: 'Hi' } },
      },
    ]
  },
  async activate(itemId, actionId, ctx) {
    /* for kind: 'custom' actions */
  },
}
```

Types: `packages/sdk/src/index.ts` (`defineExtension`, `ExtensionContext`, …).

### Isolation

- Each extension runs in its **own process** (Electron utilityProcess) inside a **QuickJS (WebAssembly) sandbox**: no Node APIs, no filesystem, no
  network, no `require`; memory and run time are bounded. It can only call `ctx.*`, and every call is checked against the permissions you approved.
- A crash never affects Beacon: a watchdog restarts the extension with backoff (1 s, 2 s, 4 s, …); after repeated crashes it is stopped.
- Default deny. Permissions (shown in a native prompt when you enable, and again if the manifest's permissions change):
  `clipboard.read`, `clipboard.write`, `notifications`, `storage` (small private key/value store), `fs.read:<abs dir>`, `fs.write:<abs dir>` (symlinks are resolved;
  `..` and the whole disk are rejected), `exec:<prog,prog>` (exact names; argv only), `network:<host,host>` (off by default; `*.example.com` allowed; redirects are not followed).
- What extensions return is validated: only `copy`, `url` (http/https), `open`/`reveal` (absolute paths), `run` and `custom` actions. **Programs started from extension
  text always ask for confirmation**; "Always allow this exact command" stores the command's exact `[file, args]`.
- **No signatures, no store.** Anyone can hand you an extension folder; only enable extensions you trust. To share one, zip the folder.
  Remove with one click (Settings → Extensions or `ext` in the launcher; the folder goes to the trash).

### Develop

```bash
npx tsx packages/sdk/cli/create.ts ./my-ext "My Extension"     # scaffold (manifest + index.js)
npx tsx packages/sdk/cli/dev.ts ./my-ext "some query"          # run in the same sandbox, printing every ctx call and whether it would be allowed
```

Copy the folder into `<dataDir>/extensions/`; Beacon hot-reloads on every file change. Type `ext` in the launcher to enable it.

## CLI

`beacon toggle|show|hide|status|reload`, `beacon query <text> [--json]`, `beacon run <script> [-- args]`. The CLI talks to a loopback API (127.0.0.1, per-launch token in
`runtime/api.json`, mode 0600; browser requests are rejected).
