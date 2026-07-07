import { createHmac, timingSafeEqual } from 'node:crypto'

// CSRF: the SIGNED double-submit cookie pattern, exactly as security.md rule 2
// (and the OWASP CSRF Cheat Sheet) require. `SameSite=Strict` on the session
// cookie is necessary but not sufficient, so unsafe requests carry a second,
// session-bound control.
//
// The token is HMAC-SHA256(BFF_COOKIE_SECRET, sessionId). The BFF sets it in a
// READABLE `csrf` cookie (not HttpOnly — the SPA must echo it) alongside the
// HttpOnly session cookie. On an unsafe request the BFF recomputes the HMAC from
// the PRESENTED session id and constant-time-compares it to the `x-csrf-token`
// header. Because the token is bound to the session via a server-side secret, a
// naive forged/injected `csrf` cookie (from a sibling subdomain or a MITM) does
// not match a victim's session — the weakness of the *unsigned* double-submit
// cookie the cheat sheet warns about.

/** The readable double-submit cookie name the SPA echoes (src/lib/api/client.ts). */
export const CSRF_COOKIE = 'csrf'
/** The header the SPA sends it back in. HTTP header names are case-insensitive. */
export const CSRF_HEADER = 'x-csrf-token'

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** True for state-changing methods, which must carry CSRF proof. */
export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase())
}

/** The signed double-submit token for a session id: base64url HMAC-SHA256. */
export function csrfToken(secret: string, sessionId: string): string {
  return createHmac('sha256', secret).update(sessionId).digest('base64url')
}

/**
 * Verifies a presented token against a freshly recomputed HMAC of the presented
 * session id. Constant-time (`timingSafeEqual`) to avoid a comparison timing
 * oracle; length is checked first because `timingSafeEqual` throws on unequal
 * buffer lengths (a tampered/empty token is simply a mismatch, not an error).
 */
export function verifyCsrfToken(
  secret: string,
  sessionId: string,
  presented: string | null | undefined
): boolean {
  if (!presented) return false
  const expected = Buffer.from(csrfToken(secret, sessionId))
  const got = Buffer.from(presented)
  if (expected.length !== got.length) return false
  return timingSafeEqual(expected, got)
}

/**
 * Defence in depth per the Fetch-Metadata guidance: a request that the browser
 * itself labels `Sec-Fetch-Site: cross-site` is rejected BEFORE the CSRF check.
 * Only rejects when the header is present AND equals `cross-site` — the header
 * is absent on older browsers, so it augments (never replaces) the HMAC check.
 */
export function isCrossSiteRequest(secFetchSite: string | null | undefined): boolean {
  return secFetchSite === 'cross-site'
}

export type CsrfDenial = 'cross_site' | 'csrf'
export type CsrfCheck = { ok: true } | { ok: false; reason: CsrfDenial }

/**
 * The single unsafe-method gate used by /auth/logout and every proxied /api/*
 * write. Safe methods pass untouched. For unsafe methods: reject cross-site
 * first (Fetch-Metadata), then require a valid signed double-submit token.
 */
export function guardUnsafeRequest(params: {
  method: string
  secFetchSite: string | null | undefined
  sessionId: string
  presentedToken: string | null | undefined
  secret: string
}): CsrfCheck {
  if (!isUnsafeMethod(params.method)) return { ok: true }
  if (isCrossSiteRequest(params.secFetchSite)) return { ok: false, reason: 'cross_site' }
  if (!verifyCsrfToken(params.secret, params.sessionId, params.presentedToken)) {
    return { ok: false, reason: 'csrf' }
  }
  return { ok: true }
}

/** Serializes the readable `csrf` cookie. Secure + SameSite=Strict, but NOT
 *  HttpOnly (the SPA reads it) and NOT `__Host-` (the SPA references it by the
 *  bare `csrf` name). Its value is an HMAC, so being readable/forgeable buys an
 *  attacker nothing — that is the point of the signed pattern. */
export function serializeCsrfCookie(value: string): string {
  return `${CSRF_COOKIE}=${value}; Path=/; Secure; SameSite=Strict`
}

/** Expires the `csrf` cookie (logout). */
export function clearCsrfCookie(): string {
  return `${CSRF_COOKIE}=; Path=/; Secure; SameSite=Strict; Max-Age=0`
}
