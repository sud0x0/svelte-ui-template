import { describe, expect, it } from 'vitest'
import {
  createSessionStore,
  serializeHostCookie,
  clearHostCookie,
  parseCookies,
  SESSION_COOKIE,
  TXN_COOKIE,
  type SessionData,
} from './session.ts'

function sampleSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    tokens: { accessToken: 'a', refreshToken: 'r', idToken: 'i', accessTokenExpiresAt: 0 },
    claims: { sub: 'user-1' },
    expiresAt: 0,
    ...overrides,
  }
}

describe('session cookie contract (BCP 6.1.3.2)', () => {
  it('serializes the session cookie with the exact required attributes', () => {
    expect(serializeHostCookie(SESSION_COOKIE, 'abc', { httpOnly: true })).toBe(
      '__Host-session=abc; Path=/; Secure; SameSite=Strict; HttpOnly'
    )
  })

  it('serializes the short-lived txn cookie with Max-Age', () => {
    expect(serializeHostCookie(TXN_COOKIE, 'xyz', { httpOnly: true, maxAgeSeconds: 300 })).toBe(
      '__Host-txn=xyz; Path=/; Secure; SameSite=Strict; HttpOnly; Max-Age=300'
    )
  })

  it('a session cookie carries NO Max-Age and NO Domain', () => {
    const cookie = serializeHostCookie(SESSION_COOKIE, 'abc', { httpOnly: true })
    expect(cookie).not.toMatch(/Max-Age/)
    expect(cookie).not.toMatch(/Domain/)
  })

  it('clears a host cookie with Max-Age=0', () => {
    expect(clearHostCookie(SESSION_COOKIE, { httpOnly: true })).toBe(
      '__Host-session=; Path=/; Secure; SameSite=Strict; HttpOnly; Max-Age=0'
    )
  })
})

describe('parseCookies', () => {
  it('parses a Cookie header into a map and tolerates junk', () => {
    expect(parseCookies('__Host-session=a; csrf=b')).toEqual({ '__Host-session': 'a', csrf: 'b' })
    expect(parseCookies(undefined)).toEqual({})
    expect(parseCookies('nonsense; =x; ok=1')).toEqual({ ok: '1' })
  })
})

describe('in-memory session store', () => {
  it('creates a session, returns a 256-bit base64url id, and reads it back', () => {
    const store = createSessionStore({ now: () => 1000 })
    const id = store.create(sampleSession({ expiresAt: 0 }))
    // 32 bytes base64url -> 43 chars (no padding).
    expect(id).toHaveLength(43)
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(store.get(id)?.claims.sub).toBe('user-1')
    expect(store.size()).toBe(1)
  })

  it('mints distinct ids', () => {
    const store = createSessionStore()
    expect(store.create(sampleSession())).not.toBe(store.create(sampleSession()))
  })

  it('evicts and hides an expired session', () => {
    let clock = 1000
    const store = createSessionStore({ now: () => clock })
    const id = store.create(sampleSession({ expiresAt: 2000 }))
    expect(store.get(id)).toBeDefined()
    clock = 2001
    expect(store.get(id)).toBeUndefined()
    expect(store.size()).toBe(0)
  })

  it('updates tokens in place and destroys idempotently', () => {
    const store = createSessionStore({ now: () => 0 })
    const id = store.create(sampleSession({ expiresAt: 10_000 }))
    const next = sampleSession({
      expiresAt: 10_000,
      tokens: { accessToken: 'a2', accessTokenExpiresAt: 5000 },
    })
    store.update(id, next)
    expect(store.get(id)?.tokens.accessToken).toBe('a2')
    store.destroy(id)
    expect(store.get(id)).toBeUndefined()
    store.destroy(id) // no throw
  })

  it('defaults expiresAt to now + ttl when not provided', () => {
    const store = createSessionStore({ now: () => 1000, ttlMs: 500 })
    const id = store.create(sampleSession({ expiresAt: 0 }))
    // Still alive at now, gone after ttl.
    expect(store.get(id)).toBeDefined()
  })
})
