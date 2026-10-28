/** A program to run: always spawn(file, args), never a shell string. */
export interface LaunchSpec {
  file: string
  args: string[]
}

export interface AppAction {
  id: string
  title: string
  launch: LaunchSpec
}

export interface AppEntry {
  /** Stable id, unique per platform (desktop-file id, bundle path, lnk path, AppID). */
  id: string
  name: string
  keywords: string[]
  launch: LaunchSpec
  /** Absolute path to an icon file or a path Electron can fetch an icon for. */
  iconPath?: string
  /** Where the entry came from (for incremental refresh). */
  source: string
  actions: AppAction[]
}
