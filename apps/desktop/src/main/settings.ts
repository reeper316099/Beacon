import { join } from 'node:path'
import { z } from 'zod'
import { JsonFile } from '@beacon/jsonstore'

export const SettingsSchema = z.object({
  hotkey: z.string().default('Alt+Space'),
  hideOnBlur: z.boolean().default(true),
  theme: z.enum(['system', 'dark', 'light']).default('system'),
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#7c8cff'),
  /** Transparent glass window. Linux defaults to a solid surface unless enabled. */
  glass: z.boolean().default(process.platform !== 'linux'),
  clipboardPaused: z.boolean().default(false),
  launchAtLogin: z.boolean().default(false),
  display: z.enum(['cursor', 'primary']).default('cursor'),
})
export type Settings = z.infer<typeof SettingsSchema>

export function settingsFile(dataDir: string): JsonFile<Settings> {
  return new JsonFile({
    path: join(dataDir, 'config/settings.json'),
    schema: SettingsSchema,
    defaults: () => SettingsSchema.parse({}),
    version: 1,
  })
}
