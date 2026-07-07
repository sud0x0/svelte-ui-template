import { randomBytes } from 'node:crypto'

// Server-side session state and the session-cookie contract.
//
// REFERENCE IMPLEMENTATION: the session store is an in-memory Map, so sessions
// evaporate on restart and do not survive across BFF replicas. A production
// deployment swaps this for a shared external store (Redis, a database, an
// encrypted-cookie store, …) — documented in the README "Authentication"
// production-hardening notes and the /auth-integration skill. The Map lives
// behind the SessionStore interface below precisely so that swap is local.

/** Tokens held ONLY here, server-side. They never reach the browser. */
export interface StoredTokens {
  accessToken: string
  /** Rotated on every refresh (RFC 9700 §4.14). Absent if the IdP issues none. */
  refreshToken?: string
  /** Kept for RP-initiated logout (`id_token_hint`); never sent to the API. */
  idToken?: string
  /** Epoch ms when the access token expires — drives the proxy's pre-emptive refresh. */
  accessTokenExpiresAt: number
}

/** One session record: `{ tokens, claims, expiresAt }`. */
export interface SessionData {
  tokens: StoredTokens
  /** Validated ID-token claims (sub, name, email, roles, groups, …). No token strings. */
  claims: Record<string, unknown>
  /** Epoch ms — absolute session lifetime cap. After this the session is dead. */
  expiresAt: number
}

export interface SessionStore {
  /** Creates a session, returns its opaque 256-bit id. */
  create(data: SessionData): string
  /** Returns the live session, or undefined if unknown/expired (expired ones are evicted). */
  get(id: string): SessionData | undefined
  /** Replaces a session's data in place (e.g. after a token refresh). No-op if unknown. */
  update(id: string, data: SessionData): void
  /** Destroys a session (logout, refresh failure). Idempotent. */
  destroy(id: string): void
  /** Test/introspection helper: number of live records. */
  size(): number
}

export interface SessionStoreOptions {
  /** Absolute session lifetime in ms (default 12h). */
  ttlMs?: number
  /** Injectable clock for deterministic tests. */
  now?: () => number
}

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000

export function createSessionStore(opts: SessionStoreOptions = {}): SessionStore {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const now = opts.now ?? Date.now
  const store = new Map<string, SessionData>()

  return {
    create(data) {
      // 256 bits of CSPRNG entropy, base64url so it is cookie-safe with no
      // encoding. An unguessable id is the session's only secret on the wire.
      const id = randomBytes(32).toString('base64url')
      store.set(id, { ...data, expiresAt: data.expiresAt || now() + ttlMs })
      return id
    },
    get(id) {
      const data = store.get(id)
      if (data === undefined) return undefined
      if (data.expiresAt <= now()) {
        store.delete(id)
        return undefined
      }
      return data
    },
    update(id, data) {
      if (store.has(id)) store.set(id, data)
    },
    destroy(id) {
      store.delete(id)
    },
    size() {
      return store.size
    },
  }
}

// --- Login-transaction store ------------------------------------------------
// The state/nonce/PKCE-verifier for an in-flight login. Short-TTL and
// consume-once: the callback deletes it BEFORE use so a replayed callback finds
// nothing (defence against authorization-response replay). Keyed by the
// __Host-txn cookie value. Also in-memory / reference-only.

export interface LoginTransaction {
  /** OAuth `state` — CSRF on the authorization response (validated by openid-client). */
  state: string
  /** OIDC `nonce` — ID-token replay protection (validated by openid-client). */
  nonce: string
  /** PKCE code_verifier (RFC 7636) — proves this client started the flow. */
  codeVerifier: string
  /** Validated same-site path to return to after the callback. */
  returnTo: string
  /** Epoch ms after which the transaction is dead. */
  expiresAt: number
}

export interface TxnStore {
  create(txn: LoginTransaction): string
  /** Deletes AND returns the transaction (once-only); undefined if unknown/expired. */
  consume(id: string): LoginTransaction | undefined
  size(): number
}

export function createTxnStore(opts: { now?: () => number } = {}): TxnStore {
  const now = opts.now ?? Date.now
  const store = new Map<string, LoginTransaction>()
  return {
    create(txn) {
      const id = randomBytes(32).toString('base64url')
      store.set(id, txn)
      return id
    },
    consume(id) {
      const txn = store.get(id)
      // Delete BEFORE returning — even an expired hit is removed, and a second
      // callback with the same id gets undefined (replay-safe).
      store.delete(id)
      if (txn === undefined) return undefined
      if (txn.expiresAt <= now()) return undefined
      return txn
    },
    size() {
      return store.size
    },
  }
}

// --- Cookie contract --------------------------------------------------------
// Attributes per draft-ietf-oauth-browser-based-apps §6.1.3.2 ("Cookie
// Security"). The __Host- prefix makes the browser REJECT the cookie unless it
// is Secure, Path=/, and has NO Domain — so a sibling subdomain or a network
// attacker cannot set or overwrite it. (RFC 6265bis §4.1.3.2.)

export const SESSION_COOKIE = '__Host-session'
/** Short-TTL login-transaction cookie (state/nonce/PKCE handle). See routes/auth.ts. */
export const TXN_COOKIE = '__Host-txn'

export interface HostCookieOptions {
  /** Set HttpOnly (session/txn cookies: yes; the readable csrf cookie: no — see csrf.ts). */
  httpOnly?: boolean
  /** Max-Age in seconds. Omit for a session cookie (cleared when the browser closes). */
  maxAgeSeconds?: number
  /**
   * SameSite policy, defaulting to 'Strict' when absent. Session and csrf cookies
   * take the Strict default. The login-transaction cookie passes 'Lax' so it
   * survives the cross-site top-level navigation back from the IdP on
   * /auth/callback (a Strict cookie is withheld on that cross-site request).
   */
  sameSite?: 'Strict' | 'Lax'
}

/**
 * Serializes a `__Host-`-prefixed Set-Cookie value with the §6.1.3.2 attributes:
 * - `Secure`   — REQUIRED by `__Host-` and by 6.1.3.2. Browsers still accept
 *   Secure cookies over `http://localhost`, so local dev on plain HTTP works.
 * - `HttpOnly` — keeps the session cookie out of JS (security.md rule 3).
 * - `SameSite`: caller-chosen via {@link HostCookieOptions.sameSite}, defaulting
 *   to `Strict` (the session and csrf cookies are never sent cross-site). The
 *   login-transaction cookie passes `Lax` because the OAuth callback is a
 *   cross-site top-level navigation and a `Strict` cookie would be withheld on
 *   it. §6.1.3.2 makes SameSite a SHOULD, not a MUST, so `Lax` here is compliant.
 * - `Path=/`   — REQUIRED by `__Host-`.
 * - no `Domain` — REQUIRED by `__Host-`; binds the cookie to this exact host.
 */
export function serializeHostCookie(name: string, value: string, opts: HostCookieOptions): string {
  const sameSite = opts.sameSite ?? 'Strict'
  const parts = [`${name}=${value}`, 'Path=/', 'Secure', `SameSite=${sameSite}`]
  if (opts.httpOnly) parts.push('HttpOnly')
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${opts.maxAgeSeconds}`)
  return parts.join('; ')
}

/** Expires a `__Host-` cookie immediately (logout / transaction consumed). */
export function clearHostCookie(name: string, opts: HostCookieOptions = {}): string {
  return serializeHostCookie(name, '', { ...opts, maxAgeSeconds: 0 })
}

/**
 * Parses a `Cookie` request header into a name→value map. Tolerant of missing
 * headers and stray whitespace; does not decode values (our cookie values are
 * base64url/HMAC, i.e. already cookie-safe).
 */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const name = pair.slice(0, eq).trim()
    if (name) out[name] = pair.slice(eq + 1).trim()
  }
  return out
}
