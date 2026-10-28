import type { Action } from '@beacon/shared'

/**
 * Source Adapter contract (v1). An adapter reads another app's data folder, read-only, and returns
 * plain items. It must never write, never throw on odd data (skip + warn), and must tolerate
 * schema-version changes. Anything an adapter hides (spoilers, grades, private text) must never be
 * present in the returned items at all: Beacon does no further filtering.
 */
export const ADAPTER_CONTRACT_VERSION = 1

export interface HubItem {
  id: string
  title: string
  subtitle?: string
  kind: string
  keywords?: string[]
  primary: Action
  actions?: Action[]
  preview?: { type: 'markdown' | 'text'; value: string }
  /** Higher sorts first among equally good matches. */
  boost?: number
  /** Shown in the empty state (e.g. a deadline due today). */
  today?: boolean
}

export interface LoadOptions {
  now: Date
  /** Worldloom: show spoilers. Default false. */
  showSpoilers?: boolean
}

export interface LoadResult {
  items: HubItem[]
  /** Human-readable problems (skipped files, newer schema versions). Never contain item content. */
  warnings: string[]
}

export interface SourceAdapter {
  readonly contractVersion: typeof ADAPTER_CONTRACT_VERSION
  readonly id: 'lorekeeper' | 'cipherkeep' | 'worldloom' | 'classpad' | (string & {})
  readonly name: string
  /** Custom URL scheme this app is expected to handle (see docs/INTEGRATIONS.md). */
  readonly scheme: string
  readonly triggers: string[]
  /** Env var that overrides the data dir, and the folder name under the OS app-data dir. */
  readonly dataDirEnv: string
  readonly folderName: string
  load(dir: string, opts: LoadOptions): Promise<LoadResult>
}

export interface IntegrationConfig {
  enabled: boolean
  /** Override of the auto-detected data folder. */
  dir?: string
  /** Set true once the app handles its `scheme://` links; until then "Open" launches the app. */
  deepLinks: boolean
  /** Worldloom only: include spoiler-gated pages. Off by default. */
  showSpoilers: boolean
}

export type IntegrationsFile = Record<string, IntegrationConfig>

export const deepLink = (scheme: string, path: string, params: Record<string, string>): string =>
  `${scheme}://${path}?${new URLSearchParams(params).toString()}`
