import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { BffConfig } from './config.ts'
import type { OidcClient } from './oidc.ts'
import { createProxy } from './proxy.ts'
import {
  createSessionStore,
  type SessionStore,
  type SessionData,
  type StoredTokens,
} from './session.ts'
import { csrfToken } from './csrf.ts'

const SECRET = 'proxy-test-cookie-secret-32-bytes!!'

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
    cookieSecret: SECRET,
    scopes: 'openid',
    sessionStore: 'memory',
    valkeyKeyPrefix: 'bff:',
    valkeyConnectTimeoutMs: 10_000,
  }
}

function fakeOidc(over: Partial<OidcClient> = {}): OidcClient {
  return {
    beginLogin: () => Promise.reject(new Error('unused')),
    completeLogin: () => Promise.reject(new Error('unused')),
    refresh: (prev) => Promise.resolve(prev),
    hasEndSession: () => false,
    endSessionUrl: () => '',
    ...over,
  }
}

function tokens(over: Partial<StoredTokens> = {}): StoredTokens {
  return {
    accessToken: 'access-original',
    refreshToken: 'refresh-original',
    idToken: 'id-original',
    accessTokenExpiresAt: Date.now() + 3_600_000, // fresh by default
    ...over,
  }
}

function session(t: StoredTokens): SessionData {
  return { tokens: t, claims: { sub: 'u1' }, expiresAt: Date.now() + 3_600_000 }
}

/** A stub upstream captured per-request, plus a mounted proxy server. */
interface Harness {
  base: string
  sessions: SessionStore
  captured: { url: string; headers: Headers }[]
  close: () => Promise<void>
}

async function mount(opts: {
  oidc?: OidcClient
  respond?: (req: { url: string; headers: Headers }) => Response
  config?: BffConfig
}): Promise<Harness> {
  const captured: { url: string; headers: Headers }[] = []
  const sessions = createSessionStore()
  const fetchImpl = ((input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    const rec = { url, headers }
    captured.push(rec)
    return Promise.resolve(
      opts.respond ? opts.respond(rec) : new Response('{"ok":true}', { status: 200 })
    )
  }) as typeof fetch

  const proxy = createProxy({
    config: opts.config ?? baseConfig(),
    sessions,
    oidc: opts.oidc ?? fakeOidc(),
    fetchImpl,
  })

  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (path === '/health') return void proxy.health(req, res)
    return void proxy.api(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  return {
    base: `http://127.0.0.1:${addr.port}`,
    sessions,
    captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('authenticated proxy', () => {
  let h: Harness
  afterEach(async () => {
    await h.close()
  })

  it('attaches the session bearer and STRIPS inbound Authorization + Cookie', async () => {
    h = await mount({})
    const sid = await h.sessions.create(session(tokens({ accessToken: 'the-real-token' })))
    const res = await fetch(`${h.base}/api/v1/logs?limit=10`, {
      headers: {
        cookie: `__Host-session=${sid}`,
        authorization: 'Bearer attacker-smuggled',
        'x-request-id': 'req-42',
      },
    })
    expect(res.status).toBe(200)
    const upstream = h.captured[0]
    expect(upstream.url).toBe('http://upstream.test/api/v1/logs?limit=10')
    // Only the BFF's bearer reaches the API.
    expect(upstream.headers.get('authorization')).toBe('Bearer the-real-token')
    expect(upstream.headers.has('cookie')).toBe(false)
    // Tracing header forwarded.
    expect(upstream.headers.get('x-request-id')).toBe('req-42')
  })

  it('forwards ONLY allowlisted request headers upstream (allowlist, fix 3)', async () => {
    h = await mount({})
    const sid = await h.sessions.create(session(tokens()))
    const res = await fetch(`${h.base}/api/v1/logs`, {
      method: 'POST',
      headers: {
        cookie: `__Host-session=${sid}`,
        'x-csrf-token': csrfToken(SECRET, sid),
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        accept: 'application/json',
        'x-request-id': 'rid-allow',
        // Not on the allowlist — must NOT reach the upstream.
        'x-secret-internal': 'leak-me',
        'x-custom-tracking': 'nope',
      },
      body: JSON.stringify({ a: 1 }),
    })
    expect(res.status).toBe(200)
    const up = h.captured[0].headers
    // Allowlisted headers pass through.
    expect(up.get('content-type')).toBe('application/json')
    expect(up.get('accept')).toBe('application/json')
    expect(up.get('x-request-id')).toBe('rid-allow')
    // Everything else is dropped by default — including the SPA's CSRF token,
    // which the BFF consumes and the Go API has no use for.
    expect(up.has('x-secret-internal')).toBe(false)
    expect(up.has('x-custom-tracking')).toBe(false)
    expect(up.has('x-csrf-token')).toBe(false)
    expect(up.has('cookie')).toBe(false)
    expect(up.has('sec-fetch-site')).toBe(false)
  })

  it('strips inbound forwarding headers and re-sets a single trusted X-Forwarded-For (item 2)', async () => {
    h = await mount({})
    const sid = await h.sessions.create(session(tokens()))
    const res = await fetch(`${h.base}/api/v1/logs`, {
      headers: {
        cookie: `__Host-session=${sid}`,
        'x-forwarded-for': '9.9.9.9',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'ftp',
        'x-real-ip': '9.9.9.9',
        forwarded: 'for=9.9.9.9;host=evil.example;proto=ftp',
      },
    })
    expect(res.status).toBe(200)
    const up = h.captured[0].headers
    // The spoofable trust headers never reach the upstream.
    expect(up.has('x-forwarded-host')).toBe(false)
    expect(up.has('x-forwarded-proto')).toBe(false)
    expect(up.has('x-real-ip')).toBe(false)
    expect(up.has('forwarded')).toBe(false)
    // X-Forwarded-For is REPLACED with the un-spoofable peer address (loopback in
    // this test), never the client-supplied 9.9.9.9.
    const xff = up.get('x-forwarded-for')
    expect(xff).not.toBeNull()
    expect(xff).not.toBe('9.9.9.9')
  })

  it('trusted-proxy mode PRESERVES the inbound X-Forwarded-For and appends the peer (fix 11)', async () => {
    h = await mount({ config: { ...baseConfig(), trustedProxy: true } })
    const sid = await h.sessions.create(session(tokens()))
    const res = await fetch(`${h.base}/api/v1/logs`, {
      headers: { cookie: `__Host-session=${sid}`, 'x-forwarded-for': '203.0.113.7' },
    })
    expect(res.status).toBe(200)
    const xff = h.captured[0].headers.get('x-forwarded-for')
    // The trusted upstream chain is preserved (real client first), peer appended.
    expect(xff).not.toBeNull()
    expect(xff!.startsWith('203.0.113.7, ')).toBe(true)
  })

  it('no session -> the Go 401 envelope, byte-for-byte, and does NOT proxy', async () => {
    h = await mount({})
    const res = await fetch(`${h.base}/api/v1/logs`)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorised', message: 'no active session' })
    expect(h.captured).toHaveLength(0)
  })

  it('passes a 403 through untouched (403 is not 401)', async () => {
    h = await mount({
      respond: () => new Response('{"error":"forbidden"}', { status: 403 }),
    })
    const sid = await h.sessions.create(session(tokens()))
    const res = await fetch(`${h.base}/api/v1/logs`, {
      headers: { cookie: `__Host-session=${sid}` },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
  })

  it('health passthrough is unauthenticated (no bearer attached)', async () => {
    h = await mount({})
    const res = await fetch(`${h.base}/health`)
    expect(res.status).toBe(200)
    expect(h.captured[0].url).toBe('http://upstream.test/health')
    expect(h.captured[0].headers.has('authorization')).toBe(false)
  })

  it('refreshes SINGLE-FLIGHT: two concurrent expiring calls hit the token endpoint once', async () => {
    let refreshCount = 0
    const oidc = fakeOidc({
      refresh: async (prev) => {
        refreshCount += 1
        await new Promise((r) => setTimeout(r, 25)) // hold the flight open
        return { ...prev, accessToken: 'refreshed-access', refreshToken: 'refresh-rotated' }
      },
    })
    h = await mount({ oidc })
    const sid = await h.sessions.create(session(tokens({ accessTokenExpiresAt: Date.now() }))) // expiring now

    const [a, b] = await Promise.all([
      fetch(`${h.base}/api/x`, { headers: { cookie: `__Host-session=${sid}` } }),
      fetch(`${h.base}/api/x`, { headers: { cookie: `__Host-session=${sid}` } }),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(refreshCount).toBe(1) // single-flight

    // Both upstream calls carried the refreshed token, and the rotated refresh
    // token was persisted.
    expect(
      h.captured.every((c) => c.headers.get('authorization') === 'Bearer refreshed-access')
    ).toBe(true)
    expect((await h.sessions.get(sid))?.tokens.refreshToken).toBe('refresh-rotated')
  })

  it('destroys the session and answers 401 when refresh fails', async () => {
    const oidc = fakeOidc({ refresh: () => Promise.reject(new Error('invalid_grant')) })
    h = await mount({ oidc })
    const sid = await h.sessions.create(session(tokens({ accessTokenExpiresAt: Date.now() })))
    const res = await fetch(`${h.base}/api/x`, { headers: { cookie: `__Host-session=${sid}` } })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorised', message: 'session expired' })
    expect(await h.sessions.get(sid)).toBeUndefined()
    expect(h.captured).toHaveLength(0) // never proxied
  })

  it('rejects an unsafe /api write without a valid CSRF token, and accepts it with one', async () => {
    h = await mount({})
    const sid = await h.sessions.create(session(tokens()))
    const noToken = await fetch(`${h.base}/api/v1/logs`, {
      method: 'POST',
      headers: { cookie: `__Host-session=${sid}`, 'sec-fetch-site': 'same-origin' },
    })
    expect(noToken.status).toBe(403)
    expect(h.captured).toHaveLength(0)

    const withToken = await fetch(`${h.base}/api/v1/logs`, {
      method: 'POST',
      headers: {
        cookie: `__Host-session=${sid}`,
        'x-csrf-token': csrfToken(SECRET, sid),
        'sec-fetch-site': 'same-origin',
      },
    })
    expect(withToken.status).toBe(200)
    expect(h.captured).toHaveLength(1)
  })

  it('bounds the upstream call: 504 gateway_timeout on abort, fast responses unaffected', async () => {
    // Simulate a hung upstream by rejecting with the shape AbortSignal.timeout
    // produces (name TimeoutError), keyed off the URL so one harness serves both
    // a fast and a slow path. No wall-clock wait.
    const timeoutErr = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    h = await mount({
      respond: (rec) => {
        if (rec.url.includes('/slow')) throw timeoutErr
        return new Response('{"ok":true}', { status: 200 })
      },
    })
    const sid = await h.sessions.create(session(tokens()))

    // Fast path: the timeout signal does not affect a prompt response.
    const fast = await fetch(`${h.base}/api/fast`, { headers: { cookie: `__Host-session=${sid}` } })
    expect(fast.status).toBe(200)

    // Hung upstream aborts -> the Go 504 envelope, byte-for-byte.
    const slow = await fetch(`${h.base}/api/slow`, { headers: { cookie: `__Host-session=${sid}` } })
    expect(slow.status).toBe(504)
    expect(await slow.json()).toEqual({ error: 'gateway_timeout', message: 'upstream timed out' })
  })

  it('rejects an unsafe /api write labelled Sec-Fetch-Site: cross-site', async () => {
    h = await mount({})
    const sid = await h.sessions.create(session(tokens()))
    const res = await fetch(`${h.base}/api/v1/logs`, {
      method: 'POST',
      headers: {
        cookie: `__Host-session=${sid}`,
        'x-csrf-token': csrfToken(SECRET, sid),
        'sec-fetch-site': 'cross-site',
      },
    })
    expect(res.status).toBe(403)
    expect(h.captured).toHaveLength(0)
  })

  it('strips an upstream Set-Cookie so it can never reach the browser (item 7)', async () => {
    // A hostile/misbehaving upstream tries to overwrite the session cookie.
    h = await mount({
      respond: () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'set-cookie': '__Host-session=evil; Path=/' },
        }),
    })
    const sid = await h.sessions.create(session(tokens()))
    const res = await fetch(`${h.base}/api/v1/logs`, {
      headers: { cookie: `__Host-session=${sid}` },
    })
    expect(res.status).toBe(200)
    // The BFF response carries NO set-cookie — the proxy owns cookies, not upstream.
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it('answers 502 bad_gateway on a non-timeout upstream failure, without crashing', async () => {
    // undici surfaces ECONNREFUSED / DNS failure / connection reset as a TypeError.
    h = await mount({
      respond: () => {
        throw new TypeError('fetch failed')
      },
    })
    const sid = await h.sessions.create(session(tokens()))
    const res = await fetch(`${h.base}/api/v1/logs`, {
      headers: { cookie: `__Host-session=${sid}` },
    })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'bad_gateway', message: 'upstream unavailable' })
  })

  it('destroys the socket when the upstream body fails mid-stream (headers already sent)', async () => {
    // A 200 whose body errors after the first chunk: the status line is already on
    // the wire, so the proxy cannot switch to a 5xx and must break the connection.
    const brokenBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'))
        controller.error(new Error('upstream reset mid-stream'))
      },
    })
    h = await mount({ respond: () => new Response(brokenBody, { status: 200 }) })
    const sid = await h.sessions.create(session(tokens()))
    await expect(
      fetch(`${h.base}/api/v1/logs`, { headers: { cookie: `__Host-session=${sid}` } }).then((r) =>
        r.text()
      )
    ).rejects.toThrow()
  })
})
