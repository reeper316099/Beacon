import { createSandbox } from './sandbox'

export interface RunnerPort {
  send(msg: unknown): void
  onMessage(cb: (msg: unknown) => void): void
}

/**
 * The extension-process side. Receives `init` (the code), then `invoke`s; forwards `ctx.*` calls to the
 * host and returns the host's answer. Used by the utilityProcess entry and by tests.
 */
export function serveExtension(port: RunnerPort): void {
  let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined
  const waiting = new Map<number, (json: string) => void>()
  let seq = 0
  let ready: Promise<void> | undefined

  port.onMessage((raw) => {
    const m = raw as Record<string, unknown>
    if (m['type'] === 'init') {
      ready = createSandbox({
        code: String(m['code'] ?? ''),
        onCall: (op, args) =>
          new Promise<string>((resolve) => {
            const id = ++seq
            waiting.set(id, resolve)
            port.send({ type: 'call', id, op, args })
          }),
      }).then((s) => {
        sandbox = s
        port.send({ type: 'ready' })
      })
      ready.catch((e: Error) => port.send({ type: 'load-error', error: e.message }))
    } else if (m['type'] === 'result') {
      waiting.get(Number(m['id']))?.(String(m['json']))
      waiting.delete(Number(m['id']))
    } else if (m['type'] === 'invoke') {
      const id = m['id']
      void (ready ?? Promise.reject(new Error('not initialized')))
        .then(() => {
          if (!sandbox) throw new Error('extension failed to load')
          return sandbox.invoke(String(m['method']), (m['args'] as unknown[]) ?? [])
        })
        .then(
          (value) => port.send({ type: 'invoke-result', id, ok: true, value }),
          (e: Error) => port.send({ type: 'invoke-result', id, ok: false, error: e.message }),
        )
    }
  })
}
