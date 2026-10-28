/**
 * Beacon extension SDK (apiVersion 1).
 *
 * An extension is a folder with `manifest.json` and a CommonJS entry that assigns `module.exports`.
 * It runs inside a sandboxed JS VM with no Node APIs: everything goes through `ctx`, and `ctx` calls
 * are checked against the permissions declared in the manifest (and approved by the user).
 */

export type ActionKind = 'copy' | 'url' | 'open' | 'reveal' | 'run' | 'custom'

export interface ExtensionAction {
  id: string
  title: string
  kind: ActionKind
  /** copy: { text } · url: { url } · open/reveal: { path } · run: { file, args } · custom: handled by activate() */
  payload?: Record<string, unknown>
}

export interface ExtensionItem {
  id: string
  title: string
  subtitle?: string
  /** A single emoji. */
  icon?: string
  score?: number
  primary: ExtensionAction
  actions?: ExtensionAction[]
}

export interface ExtensionQuery {
  text: string
  terms: string[]
  trigger?: string
  command?: string
}

export interface ExtensionContext {
  /** permission: clipboard.read / clipboard.write */
  clipboard: { read(): Promise<string>; write(text: string): Promise<void> }
  /** permission: notifications */
  notify(title: string, body?: string): Promise<void>
  /** permission: storage (small private key/value store, JSON values) */
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
  /** permissions: fs.read:<abs dir> / fs.write:<abs dir> */
  fs: { read(path: string): Promise<string>; write(path: string, data: string): Promise<void> }
  /** permission: exec:<program,...> (exact names from the allow-list; argv only, no shell) */
  exec(
    file: string,
    args?: string[],
  ): Promise<{ code: number | null; stdout: string; stderr: string }>
  /** permission: network:<host,...> (off by default; redirects are not followed) */
  fetch(
    url: string,
    opts?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; body: string }>
}

export interface Extension {
  query(q: ExtensionQuery, ctx: ExtensionContext): Promise<ExtensionItem[]> | ExtensionItem[]
  /** Called for `custom` actions. */
  activate?(itemId: string, actionId: string | null, ctx: ExtensionContext): Promise<void> | void
}

export interface ExtensionManifest {
  id: string
  name: string
  version: string
  apiVersion: 1
  main: string
  description?: string
  commands: { keyword: string; title: string }[]
  permissions: string[]
}

/** Identity helper for type checking: `module.exports = defineExtension({ ... })`. */
export const defineExtension = <T extends Extension>(ext: T): T => ext

// ---- helpers for Script Commands (also available as plain files in ./script, ./python, ./shell) ----

export interface ScriptItem {
  title: string
  subtitle?: string
  icon?: string
  value?: string
  action?: string
}

const PREFIX = '@@beacon '
const send = (m: Record<string, unknown>): void =>
  void process.stdout.write(PREFIX + JSON.stringify(m) + '\n')

/** List mode: print one result item (JSON Lines). */
export const emit = (item: ScriptItem): void =>
  void process.stdout.write(JSON.stringify(item) + '\n')
/** Show a local notification. */
export const notify = (title: string, body?: string): void =>
  send({ type: 'notify', title, ...(body ? { body } : {}) })
/** Update the progress bar (0..1) and optional label in the launcher output panel. */
export const progress = (value: number, label?: string): void =>
  send({ type: 'progress', value, ...(label ? { label } : {}) })
