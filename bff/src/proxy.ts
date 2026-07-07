import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { BffConfig } from './config.ts'
import type { OidcClient } from './oidc.ts'
import {
  SESSION_COOKIE,
  clearHostCookie,
  type SessionStore,
  type SessionData,
  type StoredTokens,
} from './session.ts'
import { clearCsrfCookie, guardUnsafeRequest } from './csrf.ts'
import { header, cookies, unauthorised, forbidden } from './http.ts'

// The authenticated reverse proxy: /api/* -> Go API with a server-side access
// token attached. The browser sends only its session cookie; the BFF turns that
// into `Authorization: Bearer <access token>` here. This is the whole point of
// the BFF — the token never enters the browser.

/** Refresh this many ms BEFORE the access token actually expires. */
const REFRESH_SKEW_MS = 30_000

// Hop-by-hop and identity headers we must NOT forward upstream. Authorization
// and Cookie are stripped so the browser can never smuggle its own credentials
// past the BFF — the ONLY Authorization the API sees is the one we attach.
const STRIP_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'proxy-authorization',
  'te',
  'trailer',
])

// Response headers that describe the ON-THE-WIRE encoding of the upstream body.
// undici's fetch already decoded the body, so re-emitting these would make the
// browser try to decode again. Strip them; Node re-frames the response.
const STRIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
])

export interface ProxyDeps {
  config: BffConfig
  sessions: SessionStore
  oidc: OidcClient
  /** Injectable fetch (tests point it at a stub upstream). Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Injectable clock (tests). */
  now?: () => number
}

export interface Proxy {
  /** Authenticated /api/* proxy. */
  api(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** Unauthenticated health passthrough (/health, /livez, /readyz). */
  health(req: IncomingMessage, res: ServerResponse): Promise<void>
}

export function createProxy(deps: ProxyDeps): Proxy {
  const { config, sessions, oidc } = deps
  const doFetch = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now

  // Single-flight refresh: at most one in-flight token refresh per session, so a
  // burst of concurrent /api/* calls on an expiring session hits the token
  // endpoint exactly ONCE. Keyed by session id; cleared when the refresh settles.
  const inflightRefresh = new Map<string, Promise<StoredTokens>>()

  /**
   * Returns fresh access tokens for a session, refreshing pre-emptively (within
   * REFRESH_SKEW_MS of expiry). Returns null if refresh fails — the caller then
   * destroys the session and answers 401. Persists the ROTATED refresh token.
   */
  async function ensureFreshTokens(
    sid: string,
    session: SessionData
  ): Promise<StoredTokens | null> {
    if (session.tokens.accessTokenExpiresAt - now() > REFRESH_SKEW_MS) {
      return session.tokens
    }
    let refresh = inflightRefresh.get(sid)
    if (refresh === undefined) {
      refresh = oidc.refresh(session.tokens)
      inflightRefresh.set(sid, refresh)
      // Clear the slot once settled (success OR failure) so a later expiry can
      // retry. This cleanup branch swallows the rejection so it never surfaces as
      // an unhandled rejection; the awaiting caller below still observes it.
      refresh.catch(() => undefined).finally(() => inflightRefresh.delete(sid))
    }
    try {
      const rotated = await refresh
      // Persist rotated tokens (incl. the rotated refresh token) in the session.
      sessions.update(sid, { ...session, tokens: rotated })
      return rotated
    } catch {
      return null
    }
  }

  async function forwardUpstream(
    req: IncomingMessage,
    res: ServerResponse,
    accessToken: string | undefined
  ): Promise<void> {
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || STRIP_REQUEST_HEADERS.has(name.toLowerCase())) continue
      // X-Request-ID and other tracing/content headers pass through here.
      for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v)
    }
    // The ONLY credential the upstream sees. Absent on health passthrough.
    if (accessToken !== undefined) headers.set('Authorization', `Bearer ${accessToken}`)

    const method = req.method ?? 'GET'
    const hasBody = method !== 'GET' && method !== 'HEAD'
    const upstream = await doFetch(`${config.apiUpstream}${req.url ?? ''}`, {
      method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      // Streaming a request body requires half-duplex mode (undici/WHATWG).
      ...(hasBody ? { duplex: 'half' } : {}),
      redirect: 'manual',
    })

    // Pass status and headers through UNTOUCHED (403 stays 403, etc.), minus the
    // encoding headers undici already applied.
    const outHeaders: Record<string, string> = {}
    upstream.headers.forEach((v, k) => {
      if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) outHeaders[k] = v
    })
    res.writeHead(upstream.status, outHeaders)
    if (upstream.body !== null) {
      await pipeline(Readable.fromWeb(upstream.body), res)
    } else {
      res.end()
    }
  }

  return {
    async api(req, res) {
      const sid = cookies(req)[SESSION_COOKIE]
      const session = sid ? sessions.get(sid) : undefined
      if (!sid || !session) {
        // No session -> the Go 401 envelope; do NOT proxy. The SPA's client sees
        // 401 and fires login(returnTo).
        return unauthorised(res, 'no active session')
      }

      // Unsafe methods carry the signed double-submit token (security.md rule 2).
      const guard = guardUnsafeRequest({
        method: req.method ?? 'GET',
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

      const tokens = await ensureFreshTokens(sid, session)
      if (tokens === null) {
        // Refresh failed (invalid_grant / network): kill the session and answer
        // 401 with cleared cookies so the SPA restarts login.
        sessions.destroy(sid)
        return unauthorised(res, 'session expired', {
          'Set-Cookie': [clearHostCookie(SESSION_COOKIE, { httpOnly: true }), clearCsrfCookie()],
        })
      }

      await forwardUpstream(req, res, tokens.accessToken)
    },

    async health(req, res) {
      // Unauthenticated liveness/readiness passthrough — no session, no bearer.
      await forwardUpstream(req, res, undefined)
    },
  }
}
