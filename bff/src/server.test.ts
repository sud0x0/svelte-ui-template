import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { BffConfig } from './config.ts'
import type { AuthRoutes } from './routes/auth.ts'
import type { Proxy } from './proxy.ts'
import { createApp, hardenServer } from './server.ts'

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
    oidcTimeoutMs: 10_000,
    trustedProxy: false,
    cookieSecret: 'server-test-cookie-secret-32byte!',
    scopes: 'openid',
    sessionStore: 'memory',
    valkeyKeyPrefix: 'bff:',
    valkeyConnectTimeoutMs: 10_000,
  }
}

const okAsync = (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end('{"ok":true}')
  return Promise.resolve()
}

interface Harness {
  base: string
  close: () => Promise<void>
}

async function mount(
  over: { authRoutes?: Partial<AuthRoutes>; proxy?: Partial<Proxy> } = {}
): Promise<Harness> {
  // All AuthRoutes handlers are async now (fix 12).
  const authRoutes: AuthRoutes = {
    login: over.authRoutes?.login ?? okAsync,
    callback: over.authRoutes?.callback ?? okAsync,
    logout: over.authRoutes?.logout ?? okAsync,
    me: over.authRoutes?.me ?? okAsync,
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

  // Fix 6: the correlation id is generated-if-absent, forwarded upstream, echoed
  // on the response, and logged.
  it('generates + forwards + logs + echoes an X-Request-ID when the client omits one', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
      logs.push(String(m))
    })
    let forwarded: string | undefined
    h = await mount({
      proxy: {
        api: (req: IncomingMessage, res: ServerResponse): Promise<void> => {
          forwarded = req.headers['x-request-id'] as string | undefined
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
          return Promise.resolve()
        },
      },
    })

    const res = await fetch(`${h.base}/api/x`) // no X-Request-ID sent
    expect(res.status).toBe(200)
    const echoed = res.headers.get('x-request-id')
    expect(echoed).toBeTruthy() // generated
    expect(forwarded).toBe(echoed) // forwarded upstream, same id
    await vi.waitFor(() => expect(logs.some((l) => l.includes(`rid=${echoed}`))).toBe(true))
    logSpy.mockRestore()
  })

  it('preserves a client-provided X-Request-ID', async () => {
    let forwarded: string | undefined
    h = await mount({
      proxy: {
        api: (req: IncomingMessage, res: ServerResponse): Promise<void> => {
          forwarded = req.headers['x-request-id'] as string | undefined
          res.writeHead(204)
          res.end()
          return Promise.resolve()
        },
      },
    })

    const res = await fetch(`${h.base}/api/x`, { headers: { 'x-request-id': 'client-rid-1' } })
    expect(res.headers.get('x-request-id')).toBe('client-rid-1')
    expect(forwarded).toBe('client-rid-1')
  })

  // Fix 1: an untrusted X-Request-ID (bad charset or over the 64-char bound) is
  // replaced with a fresh generated id before it is echoed / forwarded / logged.
  it('sanitizes a hostile or oversized X-Request-ID (mints a fresh one)', async () => {
    let forwarded: string | undefined
    h = await mount({
      proxy: {
        api: (req: IncomingMessage, res: ServerResponse): Promise<void> => {
          forwarded = req.headers['x-request-id'] as string | undefined
          res.writeHead(204)
          res.end()
          return Promise.resolve()
        },
      },
    })

    for (const hostile of ['spaces and quotes"', 'a'.repeat(65), 'has/slash', 'nl\tnope']) {
      const res = await fetch(`${h.base}/api/x`, { headers: { 'x-request-id': hostile } })
      const echoed = res.headers.get('x-request-id')
      expect(echoed).not.toBe(hostile) // replaced
      expect(echoed).toMatch(/^[A-Za-z0-9._-]{1,64}$/) // the sanitized shape
      expect(forwarded).toBe(echoed) // same sanitized id forwarded upstream
    }
  })

  // Fix 5: a request whose declared body exceeds the cap is refused with 413
  // BEFORE the handler runs — it is never buffered or streamed upstream.
  it('rejects an oversized request body with 413 before proxying', async () => {
    let proxied = false
    h = await mount({
      proxy: {
        api: (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
          proxied = true
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
          return Promise.resolve()
        },
      },
    })

    const oversized = 'a'.repeat(1_048_577) // > MAX_BODY_BYTES (1 MiB)
    const res = await fetch(`${h.base}/api/x`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversized,
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({
      error: 'payload_too_large',
      message: 'request body too large',
    })
    expect(proxied).toBe(false)
  })

  // Fix 5: the process-hardening knobs are applied (no port bind needed).
  it('hardenServer sets request/headers timeouts and the per-socket request cap', () => {
    const s = createServer(() => {})
    hardenServer(s)
    expect(s.requestTimeout).toBe(30_000)
    expect(s.headersTimeout).toBe(10_000)
    expect(s.maxRequestsPerSocket).toBe(100)
    s.close()
  })
})
