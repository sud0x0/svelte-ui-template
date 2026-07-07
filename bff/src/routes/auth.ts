import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BffConfig } from '../config.ts'
import type { OidcClient, Claims } from '../oidc.ts'
import {
  createTxnStore,
  serializeHostCookie,
  clearHostCookie,
  SESSION_COOKIE,
  TXN_COOKIE,
  type SessionStore,
  type TxnStore,
} from '../session.ts'
import { csrfToken, serializeCsrfCookie, clearCsrfCookie, guardUnsafeRequest } from '../csrf.ts'
import { header, cookies, sendJson, sendEmpty, redirect, unauthorised, forbidden } from '../http.ts'

// The /auth/* endpoints: the confidential-client OIDC flow. All token handling
// is server-side; the browser only ever receives cookies and a profile.

const TXN_TTL_MS = 300_000 // 5 minutes — matches the __Host-txn cookie Max-Age.

/**
 * Validates the opaque `return_to` the SPA forwards. It is an OPEN-REDIRECT sink
 * (security.md rule 1): accept ONLY a same-site relative path — one leading `/`,
 * never `//` or `/\` (protocol-relative), never a backslash, never a scheme or
 * authority. Anything else falls back to `/`. Exported for direct testing.
 */
export function validateReturnTo(raw: string | null | undefined, origin: string): string {
  if (!raw || !raw.startsWith('/')) return '/'
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  if (raw.includes('\\')) return '/'
  try {
    // Resolve against our own origin; if it escapes to another origin, reject.
    const url = new URL(raw, origin)
    if (url.origin !== new URL(origin).origin) return '/'
    return url.pathname + url.search + url.hash
  } catch {
    return '/'
  }
}

/**
 * Maps validated ID-token claims to the SPA's CurrentUser. Deliberately mirrors
 * go-api-template's `mapClaimsToRoles` (internal/middleware/auth_middleware.go):
 * roles = the de-duplicated UNION of the `roles` and `groups` claims, empties
 * filtered. `displayName` is the first present of name/preferred_username/email/sub.
 * Exported for testing.
 */
export function mapClaimsToUser(claims: Claims): {
  id: string
  displayName: string
  email?: string
  roles: string[]
} {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []

  const sub = str(claims.sub) ?? ''
  const email = str(claims.email)
  const displayName = str(claims.name) ?? str(claims.preferred_username) ?? email ?? sub

  // roles ∪ groups, de-duplicated, empties removed (mirror of mapClaimsToRoles).
  const roles = [...new Set([...list(claims.roles), ...list(claims.groups)].filter(Boolean))]

  const user: { id: string; displayName: string; email?: string; roles: string[] } = {
    id: sub,
    displayName,
    roles,
  }
  if (email !== undefined) user.email = email
  return user
}

export interface AuthRoutesDeps {
  config: BffConfig
  oidc: OidcClient
  sessions: SessionStore
  /** Optional injected transaction store (tests); defaults to a fresh in-memory one. */
  txns?: TxnStore
}

export interface AuthRoutes {
  login(req: IncomingMessage, res: ServerResponse): Promise<void>
  callback(req: IncomingMessage, res: ServerResponse): Promise<void>
  logout(req: IncomingMessage, res: ServerResponse): void
  me(req: IncomingMessage, res: ServerResponse): void
}

export function createAuthRoutes(deps: AuthRoutesDeps): AuthRoutes {
  const { config, oidc, sessions } = deps
  const txns = deps.txns ?? createTxnStore()

  return {
    async login(req, res) {
      const url = new URL(req.url ?? '/', config.publicOrigin)
      const returnTo = validateReturnTo(url.searchParams.get('return_to'), config.publicOrigin)

      const { authorizationUrl, transaction } = await oidc.beginLogin()
      const txnId = txns.create({ ...transaction, returnTo, expiresAt: Date.now() + TXN_TTL_MS })

      // The __Host-txn cookie is the handle to the server-side transaction, with
      // a 5-minute Max-Age (BCP 6.1.3.2). SameSite=Lax (not Strict like the
      // session cookie) so the browser still sends it on the cross-site top-level
      // navigation back from the IdP to /auth/callback, where it is consumed.
      redirect(res, authorizationUrl, [
        serializeHostCookie(TXN_COOKIE, txnId, {
          httpOnly: true,
          maxAgeSeconds: 300,
          sameSite: 'Lax',
        }),
      ])
    },

    async callback(req, res) {
      const clearTxn = clearHostCookie(TXN_COOKIE, { httpOnly: true })
      const txnId = cookies(req)[TXN_COOKIE]
      // Consume ONCE — deleted before use, so a replayed callback finds nothing.
      const txn = txnId ? txns.consume(txnId) : undefined
      if (!txn) {
        return sendJson(
          res,
          400,
          { error: 'invalid_request', message: 'no active login transaction' },
          { 'Set-Cookie': clearTxn }
        )
      }

      try {
        const currentUrl = config.publicOrigin + (req.url ?? '')
        const { tokens, claims } = await oidc.completeLogin(currentUrl, txn)
        // expiresAt: 0 lets the store apply its own absolute TTL.
        const sid = sessions.create({ tokens, claims, expiresAt: 0 })
        redirect(res, txn.returnTo, [
          serializeHostCookie(SESSION_COOKIE, sid, { httpOnly: true }),
          serializeCsrfCookie(csrfToken(config.cookieSecret, sid)),
          clearTxn,
        ])
      } catch {
        // state/nonce/PKCE/ID-token validation failed. Do not leak specifics.
        return sendJson(
          res,
          400,
          { error: 'invalid_request', message: 'login could not be completed' },
          { 'Set-Cookie': clearTxn }
        )
      }
    },

    logout(req, res) {
      const sid = cookies(req)[SESSION_COOKIE] ?? ''
      // CSRF-protected (unsafe method): Sec-Fetch-Site gate, then signed token.
      const guard = guardUnsafeRequest({
        method: 'POST',
        secFetchSite: header(req, 'sec-fetch-site'),
        sessionId: sid,
        presentedToken: header(req, 'x-csrf-token'),
        secret: config.cookieSecret,
      })
      if (!guard.ok) {
        return forbidden(
          res,
          guard.reason === 'cross_site' ? 'cross-site request blocked' : 'invalid csrf token'
        )
      }

      const session = sid ? sessions.get(sid) : undefined
      if (sid) sessions.destroy(sid)
      const clearCookies = [clearHostCookie(SESSION_COOKIE, { httpOnly: true }), clearCsrfCookie()]

      // RP-initiated logout when the IdP advertises end_session_endpoint; else 204.
      if (session?.tokens.idToken !== undefined && oidc.hasEndSession()) {
        const logoutUrl = oidc.endSessionUrl(session.tokens.idToken)
        return sendJson(res, 200, { logout_url: logoutUrl }, { 'Set-Cookie': clearCookies })
      }
      return sendEmpty(res, 204, { 'Set-Cookie': clearCookies })
    },

    me(req, res) {
      const sid = cookies(req)[SESSION_COOKIE]
      const session = sid ? sessions.get(sid) : undefined
      if (!session) {
        // The Go 401 envelope so the SPA's centralised 401 -> login seam fires.
        return unauthorised(res, 'no active session')
      }
      sendJson(res, 200, mapClaimsToUser(session.claims))
    },
  }
}
