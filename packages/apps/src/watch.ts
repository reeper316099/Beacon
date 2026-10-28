import chokidar from 'chokidar'

/**
 * Watch application roots; calls `onChange(root)` (debounced per root) so the caller
 * rescans just that root. Missing roots are tolerated.
 */
export function watchRoots(
  roots: string[],
  onChange: (root: string) => void,
  debounceMs = 400,
): () => Promise<void> {
  const timers = new Map<string, NodeJS.Timeout>()
  const w = chokidar.watch(roots, { ignoreInitial: true, depth: 2, persistent: true })
  w.on('all', (_ev, path) => {
    const root = roots.find((r) => path.startsWith(r)) ?? path
    clearTimeout(timers.get(root))
    timers.set(
      root,
      setTimeout(() => onChange(root), debounceMs),
    )
  })
  w.on('error', () => {})
  return async () => {
    for (const t of timers.values()) clearTimeout(t)
    await w.close()
  }
}
