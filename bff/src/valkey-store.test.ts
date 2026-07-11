import { beforeEach, describe, expect, it } from 'vitest'
import {
  createValkeySessionStore,
  createValkeyTxnStore,
  type ValkeyClient,
} from './valkey-store.ts'
import type { SessionData, LoginTransaction } from './session.ts'

// The Valkey adapters are held to the SAME behavioural contract as the in-memory
// stores (session.ts). Rather than a real Valkey in CI, these run against an
// in-process RESP FAKE that faithfully implements the exact commands the adapters
// use — SET (PX/XX) / GET / DEL / GETDEL / ZADD / ZCARD / ZREM / ZREMRANGEBYSCORE
// / SCAN — with a clock-driven TTL. The contract is NOT weakened to fit the fake;
// the real-Valkey restart-survival proof is a separate scripted check
// (scripts/valkey-e2e-check.mjs). See decisions #21.

class FakeValkey implements ValkeyClient {
  readonly strings = new Map<string, { value: string; expiresAtMs: number }>()
  readonly zsets = new Map<string, Map<string, number>>()
  /** Per-command error injection to exercise the fail-closed / surface-error paths. */
  readonly fail: Partial<Record<'get' | 'set' | 'getdel', boolean>> = {}

  private readonly clock: () => number
  // A plain assignment, not a parameter property — the BFF's tsconfig enables
  // `erasableSyntaxOnly` (Node native type-stripping), which forbids the latter.
  constructor(clock: () => number) {
    this.clock = clock
  }

  /** Returns the live entry, evicting it first if its PX TTL has passed (like Valkey). */
  private live(key: string): { value: string; expiresAtMs: number } | undefined {
    const e = this.strings.get(key)
    if (e === undefined) return undefined
    if (e.expiresAtMs <= this.clock()) {
      this.strings.delete(key)
      return undefined
    }
    return e
  }

  get(key: string): Promise<string | null> {
    if (this.fail.get) return Promise.reject(new Error('valkey down'))
    const e = this.live(key)
    return Promise.resolve(e ? e.value : null)
  }

  set(
    key: string,
    value: string,
    _mode: 'PX',
    ttlMs: number,
    exists?: 'XX'
  ): Promise<string | null> {
    if (this.fail.set) return Promise.reject(new Error('valkey down'))
    if (exists === 'XX' && this.live(key) === undefined) return Promise.resolve(null)
    this.strings.set(key, { value, expiresAtMs: this.clock() + ttlMs })
    return Promise.resolve('OK')
  }

  del(...keys: string[]): Promise<number> {
    let n = 0
    for (const k of keys) if (this.strings.delete(k)) n++
    return Promise.resolve(n)
  }

  getdel(key: string): Promise<string | null> {
    if (this.fail.getdel) return Promise.reject(new Error('valkey down'))
    const e = this.live(key)
    this.strings.delete(key)
    return Promise.resolve(e ? e.value : null)
  }

  zadd(key: string, score: number, member: string): Promise<number> {
    const z = this.zsets.get(key) ?? new Map<string, number>()
    const had = z.has(member)
    z.set(member, score)
    this.zsets.set(key, z)
    return Promise.resolve(had ? 0 : 1)
  }

  zcard(key: string): Promise<number> {
    return Promise.resolve(this.zsets.get(key)?.size ?? 0)
  }

  zrem(key: string, ...members: string[]): Promise<number> {
    const z = this.zsets.get(key)
    if (z === undefined) return Promise.resolve(0)
    let n = 0
    for (const m of members) if (z.delete(m)) n++
    return Promise.resolve(n)
  }

  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number> {
    const z = this.zsets.get(key)
    if (z === undefined) return Promise.resolve(0)
    const lo = Number(min)
    const hi = Number(max)
    let n = 0
    for (const [m, s] of [...z]) {
      if (s >= lo && s <= hi) {
        z.delete(m)
        n++
      }
    }
    return Promise.resolve(n)
  }

  scan(
    _cursor: string,
    _match: 'MATCH',
    pattern: string,
    _count: 'COUNT',
    _n: number
  ): Promise<[string, string[]]> {
    const rx = new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
    )
    const keys = [...this.strings.keys()].filter((k) => this.live(k) !== undefined && rx.test(k))
    // One-shot cursor: return everything and signal completion with cursor '0'.
    return Promise.resolve(['0', keys])
  }
}

function sessionData(over: Partial<SessionData> = {}): SessionData {
  return {
    tokens: { accessToken: 'at', refreshToken: 'rt', idToken: 'id', accessTokenExpiresAt: 0 },
    claims: { sub: 'u1', roles: ['user'] },
    expiresAt: 0,
    ...over,
  }
}

function txn(over: Partial<LoginTransaction> = {}): LoginTransaction {
  return { state: 's', nonce: 'n', codeVerifier: 'v', returnTo: '/', expiresAt: 0, ...over }
}

describe('createValkeySessionStore (contract parity with the in-memory store)', () => {
  let clock: number
  let fake: FakeValkey
  const now = (): number => clock
  beforeEach(() => {
    clock = 1_000_000
    fake = new FakeValkey(now)
  })

  it('create → get round-trips the session; the id is a 256-bit base64url token', async () => {
    const store = createValkeySessionStore(fake, { now, keyPrefix: 'bff:' })
    const id = await store.create(sessionData({ expiresAt: clock + 10_000 }))
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(Buffer.from(id, 'base64url')).toHaveLength(32) // 256-bit CSPRNG
    const got = await store.get(id)
    expect(got?.tokens.accessToken).toBe('at')
    expect(got?.claims).toEqual({ sub: 'u1', roles: ['user'] })
    // Stored under the namespaced key.
    expect(fake.strings.has(`bff:sess:${id}`)).toBe(true)
  })

  it('applies the default TTL for expiresAt:0 and the record self-evicts after expiry', async () => {
    const store = createValkeySessionStore(fake, { now, ttlMs: 5_000 })
    const id = await store.create(sessionData({ expiresAt: 0 }))
    expect(await store.get(id)).toBeDefined()
    clock += 5_001 // past the PX TTL
    expect(await store.get(id)).toBeUndefined()
  })

  it('update replaces in place and does NOT resurrect a destroyed session (XX guard)', async () => {
    const store = createValkeySessionStore(fake, { now })
    const id = await store.create(
      sessionData({
        expiresAt: clock + 10_000,
        tokens: { accessToken: 'old', accessTokenExpiresAt: 0 },
      })
    )
    await store.update(
      id,
      sessionData({
        expiresAt: clock + 10_000,
        tokens: { accessToken: 'new', refreshToken: 'rot', accessTokenExpiresAt: 0 },
      })
    )
    expect((await store.get(id))?.tokens.accessToken).toBe('new')

    // proxy.ts relies on update() no-op-if-gone: a session destroyed mid-refresh
    // must never be recreated by the in-flight update.
    await store.destroy(id)
    await store.update(id, sessionData({ expiresAt: clock + 10_000 }))
    expect(await store.get(id)).toBeUndefined()
  })

  it('destroy is idempotent', async () => {
    const store = createValkeySessionStore(fake, { now })
    const id = await store.create(sessionData({ expiresAt: clock + 10_000 }))
    await store.destroy(id)
    await expect(store.destroy(id)).resolves.toBeUndefined()
    expect(await store.get(id)).toBeUndefined()
  })

  it('FAIL-CLOSED: a store error on get() yields "no session" (never authenticates)', async () => {
    const store = createValkeySessionStore(fake, { now })
    const id = await store.create(sessionData({ expiresAt: clock + 10_000 }))
    fake.fail.get = true
    expect(await store.get(id)).toBeUndefined()
  })

  it('a store error on create() surfaces (rejects) — never a silent success', async () => {
    const store = createValkeySessionStore(fake, { now })
    fake.fail.set = true
    await expect(store.create(sessionData({ expiresAt: clock + 10_000 }))).rejects.toThrow()
  })

  it('size() counts live session keys', async () => {
    const store = createValkeySessionStore(fake, { now })
    await store.create(sessionData({ expiresAt: clock + 10_000 }))
    await store.create(sessionData({ expiresAt: clock + 10_000 }))
    expect(await store.size()).toBe(2)
  })
})

describe('createValkeyTxnStore (consume-once + reject-at-capacity)', () => {
  let clock: number
  let fake: FakeValkey
  const now = (): number => clock
  beforeEach(() => {
    clock = 1_000_000
    fake = new FakeValkey(now)
  })

  it('create → consume round-trips the transaction', async () => {
    const store = createValkeyTxnStore(fake, { now })
    const id = await store.create(
      txn({
        expiresAt: clock + 5_000,
        state: 'st',
        nonce: 'no',
        codeVerifier: 'ver',
        returnTo: '/x',
      })
    )
    expect(id).not.toBeNull()
    expect(await store.consume(id as string)).toEqual({
      state: 'st',
      nonce: 'no',
      codeVerifier: 'ver',
      returnTo: '/x',
      expiresAt: clock + 5_000,
    })
  })

  it('consume is once-only (GETDEL): a replayed callback finds nothing', async () => {
    const store = createValkeyTxnStore(fake, { now })
    const id = (await store.create(txn({ expiresAt: clock + 5_000 }))) as string
    expect(await store.consume(id)).toBeDefined()
    expect(await store.consume(id)).toBeUndefined() // replay-safe
  })

  it('create REJECTS at capacity (returns null), never evicting an in-flight login (#20)', async () => {
    const store = createValkeyTxnStore(fake, { now, maxEntries: 2 })
    const a = await store.create(txn({ expiresAt: clock + 5_000 }))
    const b = await store.create(txn({ expiresAt: clock + 5_000 }))
    const c = await store.create(txn({ expiresAt: clock + 5_000 }))
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(c).toBeNull() // refused at the cap...
    // ...and the two in-flight logins are untouched (never evicted).
    expect(await store.consume(a as string)).toBeDefined()
    expect(await store.consume(b as string)).toBeDefined()
  })

  it('expired transactions free capacity (score-prune) and consume to undefined', async () => {
    const store = createValkeyTxnStore(fake, { now, maxEntries: 1 })
    const a = (await store.create(txn({ expiresAt: clock + 1_000 }))) as string
    expect(await store.create(txn({ expiresAt: clock + 1_000 }))).toBeNull() // full
    clock += 1_001 // a expires
    const b = await store.create(txn({ expiresAt: clock + 1_000 }))
    expect(b).not.toBeNull() // capacity freed by the score-prune
    expect(await store.consume(a)).toBeUndefined() // expired → gone
  })

  it('FAIL-CLOSED: a store error on consume() yields "no transaction"', async () => {
    const store = createValkeyTxnStore(fake, { now })
    const id = (await store.create(txn({ expiresAt: clock + 5_000 }))) as string
    fake.fail.getdel = true
    expect(await store.consume(id)).toBeUndefined()
  })

  it('a store error on create() surfaces (rejects) — never a fake id', async () => {
    const store = createValkeyTxnStore(fake, { now })
    fake.fail.set = true
    await expect(store.create(txn({ expiresAt: clock + 5_000 }))).rejects.toThrow()
  })
})
