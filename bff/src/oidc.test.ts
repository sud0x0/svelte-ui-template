import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { accessTokenExpiryMs, DEFAULT_ACCESS_TOKEN_LIFETIME_S, createOidc } from './oidc.ts'
import type { BffConfig } from './config.ts'

function baseConfig(over: Partial<BffConfig> = {}): BffConfig {
  return {
    port: 0,
    publicOrigin: 'http://127.0.0.1',
    redirectUri: 'http://127.0.0.1/auth/callback',
    issuerUrl: 'http://127.0.0.1',
    clientId: 'c',
    clientSecret: 's',
    apiUpstream: 'http://up.test',
    apiTimeoutMs: 10_000,
    oidcTimeoutMs: 10_000,
    trustedProxy: false,
    cookieSecret: 'x'.repeat(32),
    scopes: 'openid',
    ...over,
  }
}

// Access-token expiry mapping (item 8). A missing `expires_in` must NOT map the
// expiry to "now" (which forces an immediate refresh / 401 loop right after
// login) — it falls back to a conservative default lifetime.
describe('accessTokenExpiryMs', () => {
  it('uses the IdP-provided expires_in when present', () => {
    expect(accessTokenExpiryMs(3600, 1000)).toBe(1000 + 3600 * 1000)
    expect(accessTokenExpiryMs(0, 1000)).toBe(1000) // an explicit 0 is honoured
  })

  it('falls back to a conservative default when expires_in is omitted', () => {
    expect(accessTokenExpiryMs(undefined, 1000)).toBe(1000 + DEFAULT_ACCESS_TOKEN_LIFETIME_S * 1000)
    expect(DEFAULT_ACCESS_TOKEN_LIFETIME_S).toBe(300)
  })
})

// Fix 9: openid-client calls are bounded by BFF_OIDC_TIMEOUT_MS. discovery is the
// first IdP call; a hung IdP must ABORT near the timeout, not hang for ~30s (the
// library default) or forever.
describe('createOidc bounds IdP calls with BFF_OIDC_TIMEOUT_MS', () => {
  it('rejects instead of hanging when the IdP never responds to discovery', async () => {
    const sockets = new Set<Socket>()
    // A server that accepts the connection but NEVER responds.
    const hung = createServer(() => {})
    hung.on('connection', (s) => {
      sockets.add(s)
      s.on('close', () => sockets.delete(s))
    })
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve))
    const addr = hung.address()
    if (addr === null || typeof addr === 'string') throw new Error('no port')
    const issuerUrl = `http://127.0.0.1:${addr.port}`

    try {
      const start = Date.now()
      await expect(
        createOidc(baseConfig({ issuerUrl, oidcTimeoutMs: 300 }), { allowInsecure: true })
      ).rejects.toThrow()
      // Aborted around the 300ms timeout, nowhere near the 30s library default.
      expect(Date.now() - start).toBeLessThan(5000)
    } finally {
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => hung.close(() => resolve()))
    }
  })
})
