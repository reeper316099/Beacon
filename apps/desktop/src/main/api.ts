import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Fastify from 'fastify'

export interface ApiHandlers {
  toggle(): void
  show(): void
  hide(): void
  status(): unknown
}

/** Local control API: 127.0.0.1, ephemeral port, per-launch bearer token. Not the search hot path. */
export async function startApi(dataDir: string, h: ApiHandlers): Promise<() => Promise<void>> {
  const token = randomBytes(32).toString('hex')
  const expected = Buffer.from(`Bearer ${token}`)
  const app = Fastify({ logger: false })
  let port = 0

  app.addHook('onRequest', async (req, reply) => {
    // Block browsers (CSRF / DNS rebinding): no Origin, and Host must be our loopback address.
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${port}`)
      return reply.code(403).send({ error: 'forbidden' })
    const got = Buffer.from(req.headers.authorization ?? '')
    if (got.length !== expected.length || !timingSafeEqual(got, expected))
      return reply.code(401).send({ error: 'unauthorized' })
  })
  app.post('/v1/toggle', async () => (h.toggle(), { ok: true }))
  app.post('/v1/show', async () => (h.show(), { ok: true }))
  app.post('/v1/hide', async () => (h.hide(), { ok: true }))
  app.get('/v1/status', async () => h.status())

  await app.listen({ host: '127.0.0.1', port: 0 })
  port = (app.server.address() as { port: number }).port
  const file = join(dataDir, 'runtime/api.json')
  await mkdir(join(dataDir, 'runtime'), { recursive: true })
  await writeFile(file, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 })
  await chmod(file, 0o600).catch(() => {})
  return () => app.close()
}
