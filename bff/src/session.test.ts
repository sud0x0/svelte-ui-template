import { describe, expect, it } from 'vitest'
import {
  createSessionStore,
  createTxnStore,
  startUnrefInterval,
  serializeHostCookie,
  clearHostCookie,
  parseCookies,
  SESSION_COOKIE,
  TXN_COOKIE,
  type SessionData,
  type LoginTransaction,
} from './session.ts'

function sampleSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    tokens: { accessToken: 'a', refreshToken: 'r', idToken: 'i', accessTokenExpiresAt: 0 },
    claims: { sub: 'user-1' },
    expiresAt: 0,
    ...overrides,
  }
}

function sampleTxn(overrides: Partial<LoginTransaction> = {}): LoginTransaction {
  return { state: 's', nonce: 'n', codeVerifier: 'v', returnTo: '/', expiresAt: 0, ...overrides }
}

// A no-op scheduler so a store under test creates NO real timer.
const noSweep = (): void => {}

describe('session cookie contract (BCP 6.1.3.2)', () => {
  it('serializes the session cookie with the exact required attributes', () => {
    expect(serializeHostCookie(SESSION_COOKIE, 'abc', { httpOnly: true })).toBe(
      '__Host-session=abc; Path=/; Secure; SameSite=Strict; HttpOnly'
    )
  })

  it('serializes the short-lived txn cookie with SameSite=Lax and Max-Age', () => {
    // The login-transaction cookie is Lax (not Strict) so the browser still sends
    // it on the cross-site top-level callback navigation from the IdP (S1). See
    // routes/auth.ts login().
    expect(
      serializeHostCookie(TXN_COOKIE, 'xyz', {
        httpOnly: true,
        maxAgeSeconds: 300,
        sameSite: 'Lax',
      })
    ).toBe('__Host-txn=xyz; Path=/; Secure; SameSite=Lax; HttpOnly; Max-Age=300')
  })

  it('defaults SameSite to Strict when no sameSite option is given', () => {
    expect(serializeHostCookie(SESSION_COOKIE, 'abc', { httpOnly: true })).toContain(
      'SameSite=Strict'
    )
    // An explicit Strict is byte-identical to the default.
    expect(serializeHostCookie(SESSION_COOKIE, 'abc', { httpOnly: true, sameSite: 'Strict' })).toBe(
      serializeHostCookie(SESSION_COOKIE, 'abc', { httpOnly: true })
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

describe('in-memory session store (async interface, fix 12)', () => {
  it('creates a session, returns a 256-bit base64url id, and reads it back', async () => {
    const store = createSessionStore({ now: () => 1000 })
    const id = await store.create(sampleSession({ expiresAt: 0 }))
    // 32 bytes base64url -> 43 chars (no padding).
    expect(id).toHaveLength(43)
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect((await store.get(id))?.claims.sub).toBe('user-1')
    expect(await store.size()).toBe(1)
  })

  it('mints distinct ids', async () => {
    const store = createSessionStore()
    expect(await store.create(sampleSession())).not.toBe(await store.create(sampleSession()))
  })

  it('evicts and hides an expired session', async () => {
    let clock = 1000
    const store = createSessionStore({ now: () => clock })
    const id = await store.create(sampleSession({ expiresAt: 2000 }))
    expect(await store.get(id)).toBeDefined()
    clock = 2001
    expect(await store.get(id)).toBeUndefined()
    expect(await store.size()).toBe(0)
  })

  it('updates tokens in place and destroys idempotently', async () => {
    const store = createSessionStore({ now: () => 0 })
    const id = await store.create(sampleSession({ expiresAt: 10_000 }))
    const next = sampleSession({
      expiresAt: 10_000,
      tokens: { accessToken: 'a2', accessTokenExpiresAt: 5000 },
    })
    await store.update(id, next)
    expect((await store.get(id))?.tokens.accessToken).toBe('a2')
    await store.destroy(id)
    expect(await store.get(id)).toBeUndefined()
    await store.destroy(id) // no throw
  })

  it('defaults expiresAt to now + ttl when not provided', async () => {
    const store = createSessionStore({ now: () => 1000, ttlMs: 500 })
    const id = await store.create(sampleSession({ expiresAt: 0 }))
    // Still alive at now, gone after ttl.
    expect(await store.get(id)).toBeDefined()
  })
})

describe('store memory bounding (item 4)', () => {
  it('sweeps expired sessions WITHOUT any lookup', async () => {
    let clock = 1000
    let sweep: () => void = () => {}
    const store = createSessionStore({
      now: () => clock,
      startSweep: (fn) => {
        sweep = fn
      },
    })
    await store.create(sampleSession({ expiresAt: 2000 }))
    await store.create(sampleSession({ expiresAt: 9000 }))
    expect(await store.size()).toBe(2)

    clock = 2001
    sweep() // periodic sweep — no get() call drives this eviction
    expect(await store.size()).toBe(1)
  })

  it('caps live sessions by evicting the oldest', async () => {
    const store = createSessionStore({ maxEntries: 3, now: () => 1000, startSweep: noSweep })
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push(await store.create(sampleSession({ expiresAt: 10_000 })))
    expect(await store.size()).toBe(3)
    expect(await store.get(ids[0])).toBeUndefined() // oldest evicted by the cap
    expect(await store.get(ids[3])).toBeDefined() // newest kept (not expired at now=1000)
  })

  it('sweeps expired transactions WITHOUT any lookup', async () => {
    let clock = 1000
    let sweep: () => void = () => {}
    const store = createTxnStore({
      now: () => clock,
      startSweep: (fn) => {
        sweep = fn
      },
    })
    await store.create(sampleTxn({ expiresAt: 2000 }))
    await store.create(sampleTxn({ expiresAt: 9000 }))
    expect(await store.size()).toBe(2)

    clock = 2001
    sweep() // no consume() call drives this eviction
    expect(await store.size()).toBe(1)
  })

  it('caps live transactions by REJECTING new ones (never evicting an in-flight login)', async () => {
    const store = createTxnStore({ maxEntries: 2, now: () => 1000, startSweep: noSweep })
    const first = await store.create(sampleTxn({ expiresAt: 9000 }))
    const second = await store.create(sampleTxn({ expiresAt: 9000 }))
    const overflow = await store.create(sampleTxn({ expiresAt: 9000 })) // exceeds cap 2
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(overflow).toBeNull() // rejected, not evicting the oldest
    expect(await store.size()).toBe(2)
    // The two earlier (in-flight) transactions survive and are still consumable.
    expect(await store.consume(first as string)).toBeDefined()
  })

  it('startUnrefInterval schedules an unref-ed timer so the process can exit', () => {
    const timer = startUnrefInterval(() => {}, 60_000)
    expect(timer.hasRef()).toBe(false)
    clearInterval(timer)
  })
})
