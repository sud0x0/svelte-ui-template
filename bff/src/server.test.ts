import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { BffConfig } from './config.ts'
import type { AuthRoutes } from './routes/auth.ts'
import type { Proxy } from './proxy.ts'
import { createApp } from './server.ts'

// The composition root's crash guard: a handler that throws (sync) or rejects
// (async) must degrade to a 500 envelope for that one request, never take down
// the process. Regression guard for the `void handler()` unhandled-rejection bug.

function baseConfig(): BffConfig {
  return {
    port: 0,
    publicOrigin: 'http://127.0.0.1',
    redirectUri: 'http://127.0.0.1/auth/callback',
    issuerUrl: 'http://idp.test',
    clientId: 'c',
    clientSecret: 's',
    apiUpstream: 'http://upstream.test',
    apiTimeoutMs: 10_000,
    cookieSecret: 'server-test-cookie-secret-32byte!',
    scopes: 'openid',
  }
}

const okAsync = (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end('{"ok":true}')
  return Promise.resolve()
}
const okSync = (_req: IncomingMessage, res: ServerResponse): void => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end('{"ok":true}')
}

interface Harness {
  base: string
  close: () => Promise<void>
}

async function mount(
  over: { authRoutes?: Partial<AuthRoutes>; proxy?: Partial<Proxy> } = {}
): Promise<Harness> {
  const authRoutes: AuthRoutes = {
    login: over.authRoutes?.login ?? okAsync,
    callback: over.authRoutes?.callback ?? okAsync,
    logout: over.authRoutes?.logout ?? okSync,
    me: over.authRoutes?.me ?? okSync,
  }
  const proxy: Proxy = {
    api: over.proxy?.api ?? okAsync,
    health: over.proxy?.health ?? okAsync,
  }
  const server: Server = createServer(createApp({ config: baseConfig(), authRoutes, proxy }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('createApp — handler crash guard', () => {
  let h: Harness
  afterEach(async () => {
    await h.close()
  })

  it('a synchronously-throwing handler yields a 500 envelope and keeps the process alive', async () => {
    h = await mount({
      authRoutes: {
        me: () => {
          throw new Error('boom sync')
        },
      },
    })

    const res = await fetch(`${h.base}/auth/me`)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal', message: 'internal server error' })

    // Process is alive: a healthy route still serves.
    const alive = await fetch(`${h.base}/health`)
    expect(alive.status).toBe(200)
  })

  it('an async-rejecting handler yields a 500 envelope and keeps the process alive', async () => {
    h = await mount({
      proxy: { api: () => Promise.reject(new Error('boom async')) },
    })

    const res = await fetch(`${h.base}/api/v1/logs`)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal', message: 'internal server error' })

    const alive = await fetch(`${h.base}/health`)
    expect(alive.status).toBe(200)
  })
})
