import { randomBytes } from 'node:crypto'
import type { SessionStore, SessionData, TxnStore, LoginTransaction } from './session.ts'

// OPTIONAL Valkey-backed SessionStore / TxnStore (decisions #21). Selected by
// BFF_SESSION_STORE=valkey; the default stays the in-memory reference stores in
// session.ts (decisions #18). These adapters satisfy the SAME interfaces
// byte-for-byte, so no call site changes — the whole point of those interfaces
// already being async (fix 12).
//
// SECURITY / behaviour parity with the in-memory stores:
//   - Ids are still 256-bit CSPRNG base64url, generated HERE (never from client input).
//   - TTL is enforced by Valkey (SET ... PX) so records self-evict — no sweep needed.
//   - TxnStore.consume is atomic once-only via GETDEL (replay-safe callback).
//   - TxnStore.create REJECTS at capacity (returns null), never evicts (decisions #20).
//   - FAIL-CLOSED: a store outage on a READ looks like "not found" (→ 401 re-login),
//     never an authenticated request; a WRITE that establishes auth propagates its
//     error so the caller answers 5xx, never a silent success.
//
// The concrete `iovalkey` client is constructed ONLY in server.ts (the one seam);
// these functions take a minimal injected client so the unit tests drive them with
// an in-process RESP fake and production passes a real Valkey connection.

/** Absolute session lifetime — mirrors session.ts DEFAULT_TTL_MS (12h). */
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000
/** Txn reject-at-capacity cap — mirrors session.ts DEFAULT_MAX_TXNS. */
const DEFAULT_MAX_TXNS = 10_000

/**
 * The minimal slice of the RESP client these adapters use. A real `iovalkey`
 * (ioredis-compatible) instance satisfies it structurally; the tests pass a fake.
 * Every method maps to one Valkey command with identical semantics.
 */
export interface ValkeyClient {
  get(key: string): Promise<string | null>
  /** `SET key value PX ttlMs [XX]` — XX means "only overwrite an existing key". */
  set(key: string, value: string, mode: 'PX', ttlMs: number, exists?: 'XX'): Promise<string | null>
  del(...keys: string[]): Promise<number>
  /** `GETDEL key` — atomic read-and-delete (Valkey ≥ 7 / Redis ≥ 6.2). */
  getdel(key: string): Promise<string | null>
  zadd(key: string, score: number, member: string): Promise<number | string>
  zcard(key: string): Promise<number>
  zrem(key: string, ...members: string[]): Promise<number>
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>
  scan(
    cursor: string,
    match: 'MATCH',
    pattern: string,
    count: 'COUNT',
    n: number
  ): Promise<[string, string[]]>
}

export interface ValkeySessionStoreOptions {
  /** Key namespace (default 'bff:'). */
  keyPrefix?: string
  /** Absolute session lifetime in ms (default 12h). */
  ttlMs?: number
  /** Injectable clock for deterministic tests. */
  now?: () => number
}

export interface ValkeyTxnStoreOptions {
  /** Key namespace (default 'bff:'). */
  keyPrefix?: string
  /** Hard cap on live transactions; `create` REJECTS (returns null) at the cap. */
  maxEntries?: number
  /** Injectable clock for deterministic tests. */
  now?: () => number
}

/** 256 bits of CSPRNG entropy, base64url so it is cookie-safe with no encoding. */
function newId(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Valkey-backed SessionStore. Records are `${prefix}sess:${id}` JSON blobs with a
 * PX TTL == the session's remaining absolute lifetime, so Valkey self-evicts an
 * expired session. Capacity is bounded by Valkey's own `maxmemory` +
 * eviction-policy (recommend `volatile-ttl`/`allkeys-lru`), NOT by an in-adapter
 * cap — sessions are created only AFTER a full login, so they are not the
 * unauthenticated DoS surface the txn cap guards (that is `createValkeyTxnStore`).
 */
export function createValkeySessionStore(
  client: ValkeyClient,
  opts: ValkeySessionStoreOptions = {}
): SessionStore {
  const prefix = opts.keyPrefix ?? 'bff:'
  const ttlMs = opts.ttlMs ?? DEFAULT_SESSION_TTL_MS
  const now = opts.now ?? Date.now
  const key = (id: string): string => `${prefix}sess:${id}`

  return {
    async create(data) {
      const id = newId()
      // Mirror the in-memory store: expiresAt:0 means "apply the default TTL".
      const expiresAt = data.expiresAt || now() + ttlMs
      const record: SessionData = { ...data, expiresAt }
      const px = Math.max(1, expiresAt - now())
      // Propagate a store error: the callback (server.ts dispatch) turns it into a
      // 5xx. NEVER return a fake id / silent success on a failed write.
      await client.set(key(id), JSON.stringify(record), 'PX', px)
      return id
    },

    async get(id) {
      let raw: string | null
      try {
        raw = await client.get(key(id))
      } catch {
        // FAIL CLOSED: an outage reads as "no session" → the 401 → re-login path.
        // A store error must never authenticate a request.
        return undefined
      }
      if (raw === null) return undefined
      try {
        const data = JSON.parse(raw) as SessionData
        // Defensive: Valkey would have evicted an expired key, but never trust a
        // record whose own expiry has passed.
        if (typeof data.expiresAt === 'number' && data.expiresAt <= now()) return undefined
        return data
      } catch {
        return undefined // corrupt record → treat as absent
      }
    },

    async update(id, data) {
      const expiresAt = data.expiresAt || now() + ttlMs
      const px = Math.max(1, expiresAt - now())
      // XX: overwrite ONLY an existing session, so a session destroyed mid-flight
      // is never resurrected (proxy.ts relies on update() no-op-if-gone). A store
      // error propagates → the proxy treats the refresh as failed → 401 re-login.
      await client.set(key(id), JSON.stringify(data), 'PX', px, 'XX')
    },

    async destroy(id) {
      // Best-effort idempotent cleanup: the caller already cleared the session
      // cookie and the record TTL-expires, so a transient store error here must
      // not turn logout into a 5xx.
      try {
        await client.del(key(id))
      } catch {
        /* ignore — cookie cleared + TTL bounds the record */
      }
    },

    async size() {
      // Introspection only (never on the hot path). SCAN the session keyspace.
      let cursor = '0'
      let count = 0
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}sess:*`, 'COUNT', 500)
        cursor = next
        count += keys.length
      } while (cursor !== '0')
      return count
    },
  }
}

/**
 * Valkey-backed TxnStore. Each transaction is a `${prefix}txn:${id}` JSON blob
 * (PX TTL == its short lifetime) PLUS a member in the `${prefix}txn:index` sorted
 * set scored by expiry. The zset is the capacity gauge: prune-by-score then ZCARD
 * counts LIVE transactions, so `create` can REJECT at the cap (decisions #20)
 * instead of evicting a legitimate in-flight login.
 */
export function createValkeyTxnStore(
  client: ValkeyClient,
  opts: ValkeyTxnStoreOptions = {}
): TxnStore {
  const prefix = opts.keyPrefix ?? 'bff:'
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_TXNS
  const now = opts.now ?? Date.now
  const key = (id: string): string => `${prefix}txn:${id}`
  const indexKey = `${prefix}txn:index`

  return {
    async create(txn) {
      // Reject-at-capacity (decisions #20): the UNAUTHENTICATED /auth/login must
      // NOT evict a legitimate in-flight login. Count LIVE txns via the sorted-set
      // index (prune expired by score, then ZCARD).
      //
      // NOTE: this prune+ZCARD+add is not a single atomic transaction, so under a
      // concurrent burst the live count can transiently overshoot the cap by the
      // in-flight-create count. That is acceptable and by design: the primary
      // control is the per-IP edge rate limit on /auth/login (Caddyfile,
      // decisions #20), which keeps the cap far from reach; the guarantee this
      // preserves is the load-bearing one — at/above the cap, create REJECTS
      // (returns null → the route answers 503), it never evicts. A store error
      // propagates → the dispatch crash guard answers 5xx (never a fake id).
      await client.zremrangebyscore(indexKey, 0, now())
      const live = await client.zcard(indexKey)
      if (live >= maxEntries) return null
      const id = newId()
      const px = Math.max(1, txn.expiresAt - now())
      await client.set(key(id), JSON.stringify(txn), 'PX', px)
      await client.zadd(indexKey, txn.expiresAt, id)
      return id
    },

    async consume(id) {
      let raw: string | null
      try {
        // GETDEL is ATOMIC once-only: a replayed OAuth callback finds nothing.
        raw = await client.getdel(key(id))
      } catch {
        // FAIL CLOSED: a store error reads as "no active transaction" → the
        // callback answers 400 and creates NO session. Never a silent success.
        return undefined
      }
      // Best-effort index cleanup; the score-prune in create() also removes it.
      try {
        await client.zrem(indexKey, id)
      } catch {
        /* ignore — score-prune reclaims the index member */
      }
      if (raw === null) return undefined
      try {
        const txn = JSON.parse(raw) as LoginTransaction
        if (typeof txn.expiresAt === 'number' && txn.expiresAt <= now()) return undefined
        return txn
      } catch {
        return undefined
      }
    },

    async size() {
      await client.zremrangebyscore(indexKey, 0, now())
      return client.zcard(indexKey)
    },
  }
}
