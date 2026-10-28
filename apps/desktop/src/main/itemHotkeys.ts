import { globalShortcut } from 'electron'
import { z } from 'zod'
import { JsonFile } from '@beacon/jsonstore'
import { join } from 'node:path'

const schema = z.record(z.object({ providerId: z.string(), itemId: z.string(), title: z.string() }))
type Map_ = z.infer<typeof schema>

/** Per-item global hotkeys (config/hotkeys.json): accelerator → item to activate. */
export class ItemHotkeys {
  private file: JsonFile<Map_>
  constructor(
    dataDir: string,
    private fire: (providerId: string, itemId: string) => void,
    private reserved: () => string,
  ) {
    this.file = new JsonFile({
      path: join(dataDir, 'config/hotkeys.json'),
      schema,
      defaults: () => ({}),
    })
  }

  async load(): Promise<void> {
    await this.file.load()
    this.registerAll()
  }

  registerAll(): void {
    for (const [accel, t] of Object.entries(this.file.data))
      this.register(accel, t.providerId, t.itemId)
  }

  private register(accel: string, providerId: string, itemId: string): boolean {
    try {
      return globalShortcut.register(accel, () => this.fire(providerId, itemId))
    } catch {
      return false
    }
  }

  /** Returns an error message, or null on success. */
  async bind(
    accel: string,
    providerId: string,
    itemId: string,
    title: string,
  ): Promise<string | null> {
    const a = accel.trim()
    if (!/^[A-Za-z0-9+]+$/.test(a) || !a.includes('+'))
      return `“${accel}” is not a valid shortcut (example: Ctrl+Alt+F)`
    if (a.toLowerCase() === this.reserved().toLowerCase())
      return `${a} is already Beacon's own shortcut`
    if (globalShortcut.isRegistered(a) && !this.file.data[a]) return `${a} is already in use`
    globalShortcut.unregister(a)
    if (!this.register(a, providerId, itemId))
      return `${a} couldn't be registered (another app may own it)`
    await this.file.update((d) => ({ ...d, [a]: { providerId, itemId, title } }))
    return null
  }
}
