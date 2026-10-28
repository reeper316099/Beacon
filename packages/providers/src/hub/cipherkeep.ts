import { join } from 'node:path'
import { copyAction } from '../base'
import { deepLink, type HubItem, type LoadResult, type SourceAdapter } from './types'
import { listFiles, readJson, str, strs, unwrapItems } from './util'

const SUPPORTED_SCHEMA = 1

const open = (type: string, id: string) => ({
  id: 'open',
  title: 'Open in Cipherkeep',
  kind: 'deeplink' as const,
  payload: { url: deepLink('cipherkeep', 'open', { type, id }) },
})

/**
 * Cipherkeep (read-only): commands (copy syntax!), concepts and lab titles/status.
 * Lab write-ups, flags and notes are never read into Beacon. An encrypted vault is skipped.
 */
export const cipherkeep: SourceAdapter = {
  contractVersion: 1,
  id: 'cipherkeep',
  name: 'Cipherkeep',
  scheme: 'cipherkeep',
  triggers: ['cmd ', 'ck '],
  dataDirEnv: 'CIPHERKEEP_DATA_DIR',
  folderName: 'Cipherkeep',

  async load(dir): Promise<LoadResult> {
    const items: HubItem[] = []
    const warnings: string[] = []
    if ((await readJson(join(dir, 'vault.json'))).ok) {
      return {
        items,
        warnings: [
          'Cipherkeep encryption is on; Beacon never asks for your passphrase, so it was skipped',
        ],
      }
    }
    for (const kind of ['commands', 'concepts', 'labs'] as const) {
      for (const file of await listFiles(join(dir, 'data', kind), '.json')) {
        const r = await readJson(file)
        if (!r.ok) {
          warnings.push(`skipped ${file.slice(dir.length + 1)} (${r.reason})`)
          continue
        }
        const { items: rows, schemaVersion } = unwrapItems(r.value)
        if (schemaVersion !== undefined && schemaVersion > SUPPORTED_SCHEMA + 1) {
          warnings.push(`skipped ${file.slice(dir.length + 1)} (newer schema)`)
          continue
        }
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue
          const o = row as Record<string, unknown>
          const id = str(o['id'])
          if (!id || o['archived'] === true) continue
          if (kind === 'commands') {
            const name = str(o['name']) ?? str(o['title'])
            const syntax = str(o['syntax'])
            if (!name) continue
            const examples = (Array.isArray(o['examples']) ? o['examples'] : []) as {
              command?: string
              description?: string
            }[]
            const options = (Array.isArray(o['options']) ? o['options'] : []) as {
              flag?: string
              meaning?: string
            }[]
            const risk = str(o['risk'])
            const what = str(o['whatItDoes'])
            const lines = [
              `# ${name}`,
              what ?? '',
              syntax ? '```\n' + syntax + '\n```' : '',
              str(o['explanation']) ?? '',
              options.length
                ? '**Options**\n' +
                  options.map((x) => `- \`${x.flag ?? ''}\` ${x.meaning ?? ''}`).join('\n')
                : '',
              examples.length
                ? '**Examples**\n' +
                  examples.map((x) => `- \`${x.command ?? ''}\` ${x.description ?? ''}`).join('\n')
                : '',
            ].filter(Boolean)
            const copyable = syntax ?? name
            items.push({
              id: `ck:cmd:${id}`,
              title: name,
              subtitle: [syntax ?? what, risk && risk !== 'safe' ? `⚠ ${risk}` : undefined]
                .filter(Boolean)
                .join('  ·  '),
              kind: 'command',
              keywords: [...strs(o['tags']), what ?? ''].filter(Boolean),
              primary: copyAction(copyable, syntax ? 'Copy syntax' : 'Copy name'),
              actions: [
                ...examples
                  .filter((x) => x.command)
                  .slice(0, 5)
                  .map((x, i) => ({
                    ...copyAction(
                      x.command as string,
                      `Copy example${i ? ' ' + (i + 1) : ''}: ${x.command}`,
                    ),
                    id: `ex${i}`,
                  })),
                copyAction(name, 'Copy name'),
                open('command', id),
              ].map((a) => ({ ...a, id: a.id })),
              preview: { type: 'markdown', value: lines.join('\n\n') },
              boost: 1,
            })
          } else if (kind === 'concepts') {
            const title = str(o['title'])
            if (!title) continue
            items.push({
              id: `ck:concept:${id}`,
              title,
              subtitle: ['Concept', str(o['difficulty'])].filter(Boolean).join(' · '),
              kind: 'concept',
              keywords: strs(o['tags']),
              primary: open('concept', id),
              actions: [copyAction(title, 'Copy title')],
            })
          } else {
            const title = str(o['title'])
            if (!title) continue
            // Title + status only. Write-ups and flags are deliberately not read.
            items.push({
              id: `ck:lab:${id}`,
              title,
              subtitle: ['Lab', str(o['platform']), str(o['status'])].filter(Boolean).join(' · '),
              kind: 'lab',
              keywords: strs(o['tags']),
              primary: open('lab', id),
              actions: [copyAction(title, 'Copy title')],
            })
          }
        }
      }
    }
    return { items, warnings }
  },
}
