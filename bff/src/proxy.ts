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
import { header, cookies, sendJson, unauthorised, forbidden } from './http.ts'

// The authenticated reverse proxy: /api/* -> Go API with a server-side access
// token attached. The browser sends only its session cookie; the BFF turns that
// into `Authorization: Bearer <access token>` here. This is the whole point of
// the BFF — the token never enters the browser.

/** Refresh this many ms BEFORE the access token actually expires. */
const REFRESH_SKEW_MS = 30_000

/**
 * True when a fetch rejected because it was aborted. `AbortSignal.timeout()`
 * rejects with a `TimeoutError` DOMException, a manual abort with `AbortError`.
 * We treat both as "upstream too slow" (S4).
 */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
}

// Hop-by-hop and identity headers we must NOT forward upstream. Authorization
// and Cookie are stripped so the browser can never smuggle its own credentials
// past the BFF — the ONLY Authorization the API sees is the one we attach.
//
// The proxy-trust / forwarding headers are ALSO stripped (item 2): a browser can
// set X-Forwarded-For / X-Forwarded-Host / X-Forwarded-Proto / X-Real-IP /
// Forwarded, and if the BFF relayed them verbatim the Go API might trust a SPOOFED
// client IP, host, or scheme (rate-limit bypass, cache poisoning, wrong redirect
// base). The credential-attaching BFF owns these headers, not the client
// (security.md rule 11). A single trusted X-Forwarded-For is re-set below.
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
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
])

// Response headers that describe the ON-THE-WIRE encoding of the upstream body.
// undici's fetch already decoded the body, so re-emitting these would make the
// browser try to decode again. Strip them; Node re-frames the response.
//
// `set-cookie` is ALSO stripped (item 7): the BFF owns the browser's cookies
// (__Host-session / csrf). An upstream Set-Cookie must NEVER reach the browser
// through the authenticated proxy — otherwise a compromised or misbehaving Go API
// could overwrite the session/CSRF cookies. Cookie management is the BFF's job
// alone (security.md — the proxy strips inbound credentials and attaches its own).
const STRIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'set-cookie',
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
      // Persist rotated tokens (incl. the rotated refresh token). Merge onto the
      // LATEST stored session, not the pre-await snapshot, so a concurrent
      // claims/expiry change is not clobbered (those fields are currently
      // invariant across refresh, but this keeps the write correct). update()
      // no-ops when the session is gone, so a session destroyed mid-flight is
      // never resurrected.
      const current = (await sessions.get(sid)) ?? session
      await sessions.update(sid, { ...current, tokens: rotated })
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
    // Capture the inbound X-Forwarded-For BEFORE the strip loop removes it (it is
    // in STRIP_REQUEST_HEADERS). Its trustworthiness depends on the topology (below).
    const inboundXff = header(req, 'x-forwarded-for')

    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || STRIP_REQUEST_HEADERS.has(name.toLowerCase())) continue
      // X-Request-ID and other tracing/content headers pass through here.
      for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v)
    }
    // X-Forwarded-For (item 2 + fix 11). The immediate peer address is always
    // un-spoofable, so it anchors the chain either way:
    //   - directly-exposed BFF (default): the client IS the peer, so the inbound
    //     XFF is attacker-controlled — DISCARD it and set XFF = peer only.
    //   - behind a TRUSTED proxy (config.trustedProxy, e.g. Caddy sets XFF to the
    //     real client): the inbound XFF is trustworthy — PRESERVE it and APPEND
    //     the peer, so the Go API sees `<client>, <proxy>` for per-IP audit/limit.
    const clientIp = req.socket.remoteAddress ?? ''
    if (config.trustedProxy && inboundXff) {
      headers.set('X-Forwarded-For', clientIp ? `${inboundXff}, ${clientIp}` : inboundXff)
    } else if (clientIp) {
      headers.set('X-Forwarded-For', clientIp)
    }
    // The ONLY credential the upstream sees. Absent on health passthrough.
    if (accessToken !== undefined) headers.set('Authorization', `Bearer ${accessToken}`)

    const method = req.method ?? 'GET'
    const hasBody = method !== 'GET' && method !== 'HEAD'

    let upstream: Response
    try {
      upstream = await doFetch(`${config.apiUpstream}${req.url ?? ''}`, {
        method,
        headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        // Streaming a request body requires half-duplex mode (undici/WHATWG).
        ...(hasBody ? { duplex: 'half' } : {}),
        redirect: 'manual',
        // Bound the upstream call so a hung Go API cannot pin this connection
        // until the OS socket timeout (S4). The signal also aborts the response
        // body stream, handled in the pipeline catch below.
        signal: AbortSignal.timeout(config.apiTimeoutMs),
      })
    } catch (err) {
      // The upstream call failed before any bytes went out. NEVER re-throw: an
      // unhandled rejection here crashes the whole BFF process. Answer a Go-style
      // envelope instead — a timeout is 504, and ANY other failure (ECONNREFUSED
      // while the Go API restarts, DNS failure, a connection reset surfacing as an
      // undici TypeError) is 502 bad_gateway. If headers are somehow already on
      // the wire we cannot change the status, so destroy the socket.
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (isAbortError(err)) {
        return sendJson(res, 504, { error: 'gateway_timeout', message: 'upstream timed out' })
      }
      return sendJson(res, 502, { error: 'bad_gateway', message: 'upstream unavailable' })
    }

    // Pass status and headers through UNTOUCHED (403 stays 403, etc.), minus the
    // encoding headers undici already applied.
    const outHeaders: Record<string, string> = {}
    upstream.headers.forEach((v, k) => {
      if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) outHeaders[k] = v
    })
    res.writeHead(upstream.status, outHeaders)
    if (upstream.body !== null) {
      try {
        await pipeline(Readable.fromWeb(upstream.body), res)
      } catch {
        // A failure mid-stream (timeout, or the upstream connection resetting):
        // the status line is already on the wire, so we cannot switch to a
        // 502/504. Destroy the socket so the client sees a broken connection
        // rather than a silently truncated body. Never re-throw (would crash).
        res.destroy()
        return
      }
    } else {
      res.end()
    }
  }

  return {
    async api(req, res) {
      const sid = cookies(req)[SESSION_COOKIE]
      const session = sid ? await sessions.get(sid) : undefined
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
        await sessions.destroy(sid)
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
