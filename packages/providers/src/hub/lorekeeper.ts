import { join } from 'node:path'
import { copyAction } from '../base'
import { deepLink, type HubItem, type LoadResult, type SourceAdapter } from './types'
import { listFiles, readJson, str, strs, unwrapItems } from './util'

const SUPPORTED_SCHEMA = 1

/** Lorekeeper (read-only): titles, status, progress and the "left off" bookmark. */
export const lorekeeper: SourceAdapter = {
  contractVersion: 1,
  id: 'lorekeeper',
  name: 'Lorekeeper',
  scheme: 'lorekeeper',
  triggers: ['lk ', 'lore '],
  dataDirEnv: 'LOREKEEPER_DATA_DIR',
  folderName: 'Lorekeeper',

  async load(dir): Promise<LoadResult> {
    const items: HubItem[] = []
    const warnings: string[] = []
    const meta = await readJson(join(dir, 'meta.json'))
    if (
      meta.ok &&
      typeof (meta.value as { schemaVersion?: number }).schemaVersion === 'number' &&
      (meta.value as { schemaVersion: number }).schemaVersion > SUPPORTED_SCHEMA + 3
    )
      warnings.push('Lorekeeper data is from a much newer version; some entries may be skipped')
    // Entry labels: the app can rename "extra1" (default: "Left off").
    const settings = await readJson(join(dir, 'config/settings.json'))
    const overrides = settings.ok
      ? ((settings.value as { labelOverrides?: Record<string, string> }).labelOverrides ?? {})
      : {}
    const leftOffLabel = overrides['extra1'] ?? 'Left off'

    for (const file of await listFiles(join(dir, 'data'), '.json')) {
      const r = await readJson(file)
      if (!r.ok) {
        warnings.push(`skipped ${file.slice(dir.length + 1)} (${r.reason})`)
        continue
      }
      const { items: entries, schemaVersion } = unwrapItems(r.value)
      if (schemaVersion !== undefined && schemaVersion > SUPPORTED_SCHEMA + 3) {
        warnings.push(`skipped ${file.slice(dir.length + 1)} (newer schema)`)
        continue
      }
      for (const e of entries) {
        if (!e || typeof e !== 'object') continue
        const o = e as Record<string, unknown>
        const id = str(o['id'])
        const title = str(o['title'])
        if (!id || !title) continue
        const cur = o['current'] as { raw?: string | null } | undefined
        const upTo = o['consumedUpTo'] as { raw?: string | null } | undefined
        const status = str(o['status'])?.replace(/_/g, ' ')
        const notes = (o['notes'] ?? {}) as { extra1?: string | null }
        const leftOff = str(notes.extra1 ?? undefined)
        const progress = str(cur?.raw ?? undefined)
        const parts = [
          o['library'] === 'watching'
            ? 'Watching'
            : o['library'] === 'reading'
              ? 'Reading'
              : undefined,
          status,
          progress ? `at ${progress}` : undefined,
        ].filter(Boolean)
        const preview = [
          `# ${title}`,
          status ? `Status: ${status}` : '',
          progress ? `Current: ${progress}` : '',
          str(upTo?.raw ?? undefined) ? `Consumed up to: ${upTo?.raw}` : '',
          leftOff ? `${leftOffLabel}: ${leftOff}` : '',
        ]
          .filter(Boolean)
          .join('\n\n')
        items.push({
          id: `lk:${id}`,
          title,
          subtitle: parts.join(' · '),
          kind: 'lorekeeper',
          keywords: strs(o['altTitles']),
          primary: {
            id: 'open',
            title: 'Open in Lorekeeper',
            kind: 'deeplink',
            payload: { url: deepLink('lorekeeper', 'open', { id }) },
          },
          actions: [
            ...(leftOff ? [copyAction(leftOff, `Copy “${leftOffLabel}”`)] : []),
            copyAction(title, 'Copy title'),
          ],
          preview: { type: 'markdown', value: preview },
        })
      }
    }
    return { items, warnings }
  },
}
