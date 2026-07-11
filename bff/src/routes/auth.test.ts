import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { BffConfig } from '../config.ts'
import { createOidc, type OidcClient } from '../oidc.ts'
import { createSessionStore, type SessionStore, type TxnStore } from '../session.ts'
import { createAuthRoutes, validateReturnTo, mapClaimsToUser, type AuthRoutes } from './auth.ts'
import { startStubIdp, type StubIdp } from '../testutil/stub-idp.ts'

// --- Pure-function tests (no network) ---------------------------------------

describe('validateReturnTo (open-redirect guard, security.md rule 1)', () => {
  const origin = 'https://app.example.com'
  it('accepts a same-site relative path', () => {
    expect(validateReturnTo('/items/42?tab=x', origin)).toBe('/items/42?tab=x')
    expect(validateReturnTo('/', origin)).toBe('/')
  })
  it('falls back to / for every hostile input', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'https://evil.com',
      '//evil.com',
      '/\\evil.com',
      '/path\\x',
      'javascript:alert(1)',
      'http://app.example.com.evil.com',
      'ftp://x',
    ]) {
      expect(validateReturnTo(bad, origin)).toBe('/')
    }
  })

  // The confirmed-live bypass family: each RAW value passes the literal `//`
  // guard, but WHATWG URL normalisation collapses the dot-segments to a pathname
  // that STARTS WITH `//` (a protocol-relative redirect to //evil.com). The
  // post-normalisation pathname guard must neutralise every one to `/`.
  it('neutralises dot-segment / encoded paths that normalise to a protocol-relative //', () => {
    for (const bad of [
      '/..//evil.example/phish', // the reported vector
      '/a/..//evil.com',
      '/./..//evil.com',
      '/%2e%2e//evil.com', // percent-encoded dot-dot
      '/%2e%2e//evil.com/path?q=1',
      '/..//evil.com/path?q=1',
      '/..//evil.com#frag',
      '/../..//evil.com',
    ]) {
      expect(validateReturnTo(bad, origin)).toBe('/')
    }
  })
})

describe('mapClaimsToUser (UX-only roles; the Go API is deny-by-default)', () => {
  // Tripwire (fix 5): the BFF surfaces the RAW claimed roles/groups for the SPA's
  // UX and does NOT filter them to an authorization allowlist — that is the Go
  // API's job (deny-by-default OPA policy, go-api-template decisions.md #18). If
  // someone made the BFF start filtering roles here (pretending to authorize), an
  // unlisted group like `superuser` would vanish and this test would trip.
  it('surfaces the claimed groups verbatim (does NOT allowlist-filter them)', () => {
    const user = mapClaimsToUser({ sub: 's1', groups: ['superuser', 'nonsense-team'] })
    expect(user.roles).toEqual(['superuser', 'nonsense-team'])
  })

  it('unions roles ∪ groups, de-duplicated, empties removed', () => {
    const user = mapClaimsToUser({
      sub: 's1',
      name: 'Ada',
      email: 'ada@x.io',
      roles: ['user', 'admin', ''],
      groups: ['admin', 'beta'],
    })
    expect(user).toEqual({
      id: 's1',
      displayName: 'Ada',
      email: 'ada@x.io',
      roles: ['user', 'admin', 'beta'],
    })
  })
  it('falls back through preferred_username / email / sub for displayName', () => {
    expect(mapClaimsToUser({ sub: 's1', preferred_username: 'ada' }).displayName).toBe('ada')
    expect(mapClaimsToUser({ sub: 's1', email: 'a@b' }).displayName).toBe('a@b')
    expect(mapClaimsToUser({ sub: 's1' }).displayName).toBe('s1')
    expect(mapClaimsToUser({ sub: 's1' }).roles).toEqual([])
  })
})

// --- Integration tests against a REAL stub IdP ------------------------------

function getCookie(res: Response, name: string): string | undefined {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';')
    const eq = pair.indexOf('=')
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim()
  }
  return undefined
}

describe('auth routes (confidential OIDC flow)', () => {
  let idp: StubIdp
  let server: Server
  let base: string
  let sessions: SessionStore
  let oidc: OidcClient
  let routes: AuthRoutes | null = null

  beforeAll(async () => {
    idp = await startStubIdp()

    // Bind the app first so publicOrigin (and the derived redirect_uri) match the
    // real port; then wire config → oidc → routes into the running dispatcher.
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      if (!routes) {
        res.writeHead(500)
        return res.end()
      }
      if (path === '/auth/login') return void routes.login(req, res)
      if (path === '/auth/callback') return void routes.callback(req, res)
      if (path === '/auth/logout') return void routes.logout(req, res)
      if (path === '/auth/me') return void routes.me(req, res)
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (addr === null || typeof addr === 'string') throw new Error('no port')
    base = `http://127.0.0.1:${addr.port}`

    const config: BffConfig = {
      port: addr.port,
      publicOrigin: base,
      redirectUri: `${base}/auth/callback`,
      issuerUrl: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      apiUpstream: 'http://127.0.0.1:1', // unused here
      apiTimeoutMs: 10_000,
      oidcTimeoutMs: 10_000,
      trustedProxy: false,
      cookieSecret: 'unit-test-cookie-secret-32-bytes!!',
      scopes: 'openid profile email',
    }
    oidc = await createOidc(config, { allowInsecure: true })
    sessions = createSessionStore()
    routes = createAuthRoutes({ config, oidc, sessions })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await idp.close()
  })

  beforeEach(() => {
    idp.tamperNonce = false
    idp.claims = {
      sub: 'user-123',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      roles: ['user'],
      groups: ['beta'],
    }
  })

  /** Drives login → authorize → returns {code, state, txnCookie} ready for callback. */
  async function beginLogin(returnTo = '/'): Promise<{ code: string; state: string; txn: string }> {
    const loginRes = await fetch(`${base}/auth/login?return_to=${encodeURIComponent(returnTo)}`, {
      redirect: 'manual',
    })
    expect(loginRes.status).toBe(302)
    const txn = getCookie(loginRes, '__Host-txn')
    expect(txn).toBeDefined()
    const authorizeUrl = loginRes.headers.get('location')
    expect(authorizeUrl).toContain('code_challenge_method=S256')

    const authRes = await fetch(authorizeUrl!, { redirect: 'manual' })
    expect(authRes.status).toBe(302)
    const cbUrl = new URL(authRes.headers.get('location')!)
    return {
      code: cbUrl.searchParams.get('code')!,
      state: cbUrl.searchParams.get('state')!,
      txn: txn!,
    }
  }

  it('happy path: login → callback creates a session and /auth/me returns the mapped user', async () => {
    const { code, state, txn } = await beginLogin('/dashboard')

    const cbRes = await fetch(
      `${base}/auth/callback?code=${code}&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie: `__Host-txn=${txn}` },
        redirect: 'manual',
      }
    )
    expect(cbRes.status).toBe(302)
    // The callback emits an ABSOLUTE same-origin URL (belt-and-braces open-redirect
    // defence): publicOrigin + the validated path. Same-origin, path preserved.
    const loc = cbRes.headers.get('location')!
    expect(loc).toBe(`${base}/dashboard`)
    expect(new URL(loc).origin).toBe(new URL(base).origin)
    const sid = getCookie(cbRes, '__Host-session')
    const csrf = getCookie(cbRes, 'csrf')
    expect(sid).toBeDefined()
    expect(csrf).toBeDefined()

    const meRes = await fetch(`${base}/auth/me`, { headers: { cookie: `__Host-session=${sid}` } })
    expect(meRes.status).toBe(200)
    // Authenticated JSON is never cached (ASVS V8.2, fix 10).
    expect(meRes.headers.get('cache-control')).toBe('no-store')
    expect(await meRes.json()).toEqual({
      id: 'user-123',
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      roles: ['user', 'beta'],
    })

    // logout: CSRF-protected, returns the RP-initiated logout URL, clears cookies.
    const outRes = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: `__Host-session=${sid}`,
        'x-csrf-token': csrf!,
        'sec-fetch-site': 'same-origin',
      },
      redirect: 'manual',
    })
    expect(outRes.status).toBe(200)
    const body = (await outRes.json()) as { logout_url: string }
    expect(body.logout_url).toContain('/end-session')
    expect(body.logout_url).toContain('id_token_hint=')
    // Session is gone.
    const after = await fetch(`${base}/auth/me`, { headers: { cookie: `__Host-session=${sid}` } })
    expect(after.status).toBe(401)
  })

  it('rejects a state mismatch', async () => {
    const { code, txn } = await beginLogin()
    const cbRes = await fetch(`${base}/auth/callback?code=${code}&state=tampered-state`, {
      headers: { cookie: `__Host-txn=${txn}` },
      redirect: 'manual',
    })
    expect(cbRes.status).toBe(400)
  })

  it('rejects a nonce mismatch', async () => {
    idp.tamperNonce = true
    const { code, state, txn } = await beginLogin()
    const cbRes = await fetch(
      `${base}/auth/callback?code=${code}&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie: `__Host-txn=${txn}` },
        redirect: 'manual',
      }
    )
    expect(cbRes.status).toBe(400)
  })

  it('rejects a replayed callback (transaction consumed once)', async () => {
    const { code, state, txn } = await beginLogin()
    const first = await fetch(
      `${base}/auth/callback?code=${code}&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie: `__Host-txn=${txn}` },
        redirect: 'manual',
      }
    )
    expect(first.status).toBe(302)
    const replay = await fetch(
      `${base}/auth/callback?code=${code}&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie: `__Host-txn=${txn}` },
        redirect: 'manual',
      }
    )
    expect(replay.status).toBe(400)
  })

  it('/auth/me without a session returns the Go 401 envelope', async () => {
    const res = await fetch(`${base}/auth/me`)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorised', message: 'no active session' })
  })

  it('sends NO audience param on the authorize request when none is configured (item 3)', async () => {
    await beginLogin()
    expect(idp.lastAuthorizeQuery?.get('audience')).toBeNull()
  })

  it('the stub IdP rejects an off-origin redirect_uri (registered-redirect allowlist, fix 7)', async () => {
    // A real IdP never redirects to an unregistered redirect_uri; the stub mirrors
    // that so the CodeQL open-redirect sink is closed. A hostile off-origin value
    // yields 400, not a 302 that bounces the browser to attacker-controlled origin.
    const res = await fetch(
      `${idp.issuer}/authorize?redirect_uri=${encodeURIComponent('https://evil.example/callback')}&state=x&code_challenge=y&nonce=z`,
      { redirect: 'manual' }
    )
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
  })

  it('logout with NO session is an idempotent 204, not a CSRF 403 (fix)', async () => {
    // No session cookie and no CSRF token: there is nothing to log out, so the
    // response is a clean 204 (with cookie-clearing), never the spurious 403 a
    // blank session id used to produce.
    const res = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
      redirect: 'manual',
    })
    expect(res.status).toBe(204)
    // Stale cookies are cleared for good measure (idempotent cleanup).
    const setCookie = res.headers.getSetCookie().join('\n')
    expect(setCookie).toContain('__Host-session=')
    expect(setCookie).toContain('csrf=')
  })

  it('logout with a stale/unknown session cookie is also a 204 (no CSRF required)', async () => {
    const res = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: { cookie: '__Host-session=does-not-exist', 'sec-fetch-site': 'same-origin' },
      redirect: 'manual',
    })
    expect(res.status).toBe(204)
  })

  it('logout without a valid CSRF token is 403', async () => {
    const { code, state, txn } = await beginLogin()
    const cbRes = await fetch(
      `${base}/auth/callback?code=${code}&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie: `__Host-txn=${txn}` },
        redirect: 'manual',
      }
    )
    const sid = getCookie(cbRes, '__Host-session')
    const res = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: { cookie: `__Host-session=${sid}`, 'sec-fetch-site': 'same-origin' }, // no x-csrf-token
      redirect: 'manual',
    })
    expect(res.status).toBe(403)
  })
})

describe('auth routes with a configured audience (item 3)', () => {
  let idp: StubIdp
  let server: Server
  let base: string
  let routes: AuthRoutes | null = null
  const AUDIENCE = 'https://go-api.example.com'

  beforeAll(async () => {
    idp = await startStubIdp()
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      if (!routes) {
        res.writeHead(500)
        return res.end()
      }
      if (path === '/auth/login') return void routes.login(req, res)
      if (path === '/auth/callback') return void routes.callback(req, res)
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (addr === null || typeof addr === 'string') throw new Error('no port')
    base = `http://127.0.0.1:${addr.port}`

    const config: BffConfig = {
      port: addr.port,
      publicOrigin: base,
      redirectUri: `${base}/auth/callback`,
      issuerUrl: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      apiUpstream: 'http://127.0.0.1:1',
      apiTimeoutMs: 10_000,
      oidcTimeoutMs: 10_000,
      trustedProxy: false,
      cookieSecret: 'unit-test-cookie-secret-32-bytes!!',
      scopes: 'openid profile email',
      audience: AUDIENCE,
    }
    const oidc = await createOidc(config, { allowInsecure: true })
    routes = createAuthRoutes({ config, oidc, sessions: createSessionStore() })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await idp.close()
  })

  it('carries the audience param on BOTH the authorize redirect and the token grant', async () => {
    const loginRes = await fetch(`${base}/auth/login`, { redirect: 'manual' })
    expect(loginRes.status).toBe(302)
    const txn = getCookie(loginRes, '__Host-txn')!
    const authorizeUrl = loginRes.headers.get('location')!

    const authRes = await fetch(authorizeUrl, { redirect: 'manual' })
    const cbUrl = new URL(authRes.headers.get('location')!)
    const code = cbUrl.searchParams.get('code')!
    const state = cbUrl.searchParams.get('state')!

    // The authorization request carried the audience exactly as configured.
    expect(idp.lastAuthorizeQuery?.get('audience')).toBe(AUDIENCE)

    const cbRes = await fetch(
      `${base}/auth/callback?code=${code}&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `__Host-txn=${txn}` }, redirect: 'manual' }
    )
    expect(cbRes.status).toBe(302)

    // The authorization_code token grant carried the same audience.
    expect(idp.lastTokenBody?.get('audience')).toBe(AUDIENCE)
  })
})

describe('login at transaction-store capacity (item 6)', () => {
  it('answers 503 + Retry-After instead of evicting an in-flight login', async () => {
    const config: BffConfig = {
      port: 0,
      publicOrigin: 'http://127.0.0.1',
      redirectUri: 'http://127.0.0.1/auth/callback',
      issuerUrl: 'http://idp.test',
      clientId: 'c',
      clientSecret: 's',
      apiUpstream: 'http://up.test',
      apiTimeoutMs: 10_000,
      oidcTimeoutMs: 10_000,
      trustedProxy: false,
      cookieSecret: 'unit-test-cookie-secret-32-bytes!!',
      scopes: 'openid',
    }
    const oidc: OidcClient = {
      beginLogin: () =>
        Promise.resolve({
          authorizationUrl: 'http://idp.test/authorize',
          transaction: { state: 's', nonce: 'n', codeVerifier: 'v' },
        }),
      completeLogin: () => Promise.reject(new Error('unused')),
      refresh: () => Promise.reject(new Error('unused')),
      hasEndSession: () => false,
      endSessionUrl: () => '',
    }
    // A txn store that is always "full": create() refuses.
    const fullTxns: TxnStore = {
      create: () => Promise.resolve(null),
      consume: () => Promise.resolve(undefined),
      size: () => Promise.resolve(0),
    }
    const routes = createAuthRoutes({
      config,
      oidc,
      sessions: createSessionStore(),
      txns: fullTxns,
    })

    let status = 0
    let extra: Record<string, unknown> = {}
    const res = {
      writeHead(s: number, h: Record<string, unknown>) {
        status = s
        extra = h
        return this
      },
      end() {},
    } as unknown as ServerResponse
    const req = { url: '/auth/login', method: 'GET', headers: {} } as unknown as IncomingMessage

    await routes.login(req, res)
    expect(status).toBe(503)
    expect(extra['Retry-After']).toBe('5')
  })
})
