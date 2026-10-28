import { z } from 'zod'

/** The one place the product name lives. */
export const APP_NAME = 'Beacon'

export const ActionKind = z.enum([
  'open',
  'reveal',
  'copy',
  'paste',
  'run',
  'url',
  'deeplink',
  'custom',
])
export type ActionKind = z.infer<typeof ActionKind>

export const ActionSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: ActionKind,
  payload: z.unknown(),
  confirm: z.boolean().optional(),
  shortcut: z.string().optional(),
})
export type Action = z.infer<typeof ActionSchema>

export const PreviewSchema = z.object({
  type: z.enum(['markdown', 'image', 'text']),
  value: z.string(),
})
export type Preview = z.infer<typeof PreviewSchema>

export const ResultItemSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  icon: z.string().optional(),
  kind: z.string(),
  score: z.number(),
  keywords: z.array(z.string()).optional(),
  preview: PreviewSchema.optional(),
  primary: ActionSchema,
  actions: z.array(ActionSchema).optional(),
  frecencyKey: z.string().optional(),
  sensitive: z.boolean().optional(),
})
export type ResultItem = z.infer<typeof ResultItemSchema>

export interface ParsedQuery {
  /** The raw input exactly as typed. */
  raw: string
  /** Matched trigger prefix (e.g. "cb "), if any. */
  trigger?: string
  /** Free text after trigger and filters are removed. */
  text: string
  /** Whitespace-separated free-text terms (quotes respected). */
  terms: string[]
  /** key:value filters (type, in, ext, app). */
  filters: Record<string, string>
  /** First term when a trigger is present (the command word). */
  command?: string
  /** Terms after the command word. */
  args: string[]
}

/** Side effects that must happen outside the search worker (clipboard, browser, notifications). */
export interface Effects {
  copy(text: string): Promise<void>
  openUrl(url: string): Promise<void>
  notify(title: string, body?: string): Promise<void>
  readClipboard(): Promise<string>
  /** Put a stored clipboard image (by content hash) back on the clipboard. */
  copyImage(hash: string): Promise<void>
  /** Register a global hotkey that activates an item. */
  bindHotkey(accelerator: string, providerId: string, itemId: string, title: string): Promise<void>
}

export interface ProviderContext {
  now(): number
  effects?: Effects
  [key: string]: unknown
}

export interface Provider {
  id: string
  name: string
  icon?: string
  triggers?: string[]
  mode: 'global' | 'prefix-only'
  /** Multiplier applied to match score during ranking. Default 1. */
  weight?: number
  init?(ctx: ProviderContext): Promise<void>
  query(
    q: ParsedQuery,
    ctx: ProviderContext,
    signal: AbortSignal,
  ): AsyncIterable<ResultItem> | Promise<ResultItem[]>
  actions?(item: ResultItem, ctx: ProviderContext): Action[]
  /** Execute an item's action in the process that owns the provider. Omit `actionId` for primary. */
  activate?(itemId: string, actionId: string | undefined, ctx: ProviderContext): Promise<void>
  /** Remove an item from this provider's own history (e.g. clipboard entry). */
  forget?(itemId: string): Promise<void> | void
  refresh?(): Promise<void>
}
