import type { ApiError } from '../types/api'
import { login } from './auth'

// The single fetch wrapper. Every network call in the app goes through here —
// no route or component calls `fetch` directly. It owns three auth-seam hooks
// that make `bff` mode work with no per-call changes:
//
//   1. credentials: 'include'  — always send the BFF's HttpOnly session
//      cookie. The SPA holds no token, so this cookie is the only credential.
//   2. CSRF header on unsafe methods — double-submit defence in depth.
//   3. Centralised 401 -> login(returnTo) seam.
//
// See .claude/rules/security.md and README "Authentication".

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Reads the double-submit CSRF cookie. Under VITE_AUTH_MODE='bff' the BFF sets a
 * readable (non-HttpOnly) `csrf` cookie; we echo it back in `X-CSRF-Token` on
 * unsafe methods. In disabled mode there is no such cookie, so this returns
 * `null` and no header is attached — the seam is present and correct, just inert.
 *
 * SECURITY: the SPA only ECHOES the cookie — it never mints or validates the
 * token. The BFF must set the `csrf` cookie value to a session-bound HMAC token
 * (the SIGNED double-submit pattern, not a bare random value) and verify the
 * HMAC server-side; the naive double-submit cookie is forgeable via cookie
 * injection. See .claude/rules/security.md rule 2 and decisions.md #3.
 */
function readCsrfToken(): string | null {
  // TODO(auth): if the BFF names the cookie differently or you switch to
  // Fetch-Metadata (Sec-Fetch-Site) validation, change it here. See decisions.md.
  const match = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/)
  return match?.[1] !== undefined ? decodeURIComponent(match[1]) : null
}

/** The path the user should return to after a future login redirect. */
function currentReturnTo(): string {
  return location.pathname + location.search
}

// Loop breaker (fix 8). An unconditional 401 -> login() redirect loops forever
// when the BFF session is valid but the Go API rejects its bearer (e.g. an
// audience mismatch): login -> re-auth -> 401 -> login -> … We stamp the time of
// each login redirect in sessionStorage — a NON-sensitive marker, never a token
// or session id, so security.md rule 3 permits it — and if a 401 arrives within
// this window of the last redirect, we surface an error instead of redirecting.
const LOGIN_REDIRECT_KEY = 'bff:lastLoginRedirect'
const LOGIN_LOOP_WINDOW_MS = 10_000

function markLoginRedirect(): void {
  try {
    sessionStorage.setItem(LOGIN_REDIRECT_KEY, String(Date.now()))
  } catch {
    // sessionStorage unavailable (private mode): the breaker degrades to the
    // pre-fix behaviour. Acceptable — it just can't detect the loop.
  }
}

function loopedRightAfterLogin(): boolean {
  try {
    const last = Number(sessionStorage.getItem(LOGIN_REDIRECT_KEY) ?? '0')
    return last > 0 && Date.now() - last < LOGIN_LOOP_WINDOW_MS
  } catch {
    return false
  }
}

/**
 * Clears the login-loop marker. Called on LOGOUT (auth.ts): a deliberate sign-out
 * is NOT a login loop, so a post-logout 401 must redirect to sign-in normally
 * rather than being mistaken for the audience-mismatch loop (fix 7 + fix 8).
 */
export function clearLoginLoopMarker(): void {
  try {
    sessionStorage.removeItem(LOGIN_REDIRECT_KEY)
  } catch {
    /* sessionStorage unavailable — nothing to clear */
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const text = await response.text()
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>
      if (typeof obj.error === 'string') {
        return parsed as ApiError
      }
      // Parsed as JSON but NOT the {error,message} envelope — e.g. the Go API's
      // /health 503 body `{"status":"unhealthy"}` (fix 8). NEVER dump raw JSON
      // into a UI message. If the body carries a `status` (the health-probe
      // shape), reflect it as a clean sentence (Svelte escapes it on render);
      // otherwise synthesise a generic status message.
      if (typeof obj.status === 'string') {
        return { error: 'request_failed', message: `The backend reported status "${obj.status}".` }
      }
      return { error: 'request_failed', message: `Request failed (${response.status}).` }
    }
  } catch {
    // Not JSON — a plain-text body is safe to surface directly (below).
  }
  return { error: 'request_failed', message: text || `Request failed (${response.status})` }
}

export type RequestOptions = Omit<RequestInit, 'credentials'>

/**
 * Performs a JSON request against a same-origin relative path (`/api/…`,
 * `/auth/…`, `/health`). Returns the parsed body narrowed to `T`, or throws an
 * {@link ApiError}. Handles 204 No Content. There is deliberately NO
 * retry/refresh logic — the BFF owns token refresh server-side.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = path.startsWith('/') ? path : `/${path}`
  const method = (options.method ?? 'GET').toUpperCase()

  const headers = new Headers(options.headers)
  // JSON-only by contract: callers pass a JSON string body. Set the JSON
  // Content-Type only for a string body — never blanket-tag a non-string body
  // (e.g. a FormData/Blob would set its own type). FormData support is out of
  // scope by design.
  if (typeof options.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  // Correlation id (fix 6): tag every request so the chain UI -> BFF -> Go API is
  // traceable in logs. The BFF forwards this id (and generates one itself if a
  // caller ever omits it); the Go API logs it. A fresh id per request.
  if (!headers.has('X-Request-ID')) {
    headers.set('X-Request-ID', crypto.randomUUID())
  }

  // CSRF defence in depth on state-changing requests. SameSite=Strict is
  // necessary but, per OWASP, not sufficient alone — so we attach a second
  // control. Present now; inert until the BFF sets the cookie.
  if (UNSAFE_METHODS.has(method)) {
    const csrf = readCsrfToken()
    if (csrf) headers.set('X-CSRF-Token', csrf)
  }

  const response = await fetch(url, {
    ...options,
    method,
    headers,
    // The session cookie is HttpOnly and same-origin; always send it.
    credentials: 'include',
  })

  // Centralised 401 -> login seam. In disabled mode login() is a documented
  // no-op, so this simply surfaces the error; under VITE_AUTH_MODE='bff' it
  // hands off to the BFF login redirect, preserving the current location.
  if (response.status === 401) {
    if (loopedRightAfterLogin()) {
      // We JUST returned from a login redirect and STILL got 401 (fix 8) — the
      // session authenticates but the API keeps refusing (e.g. audience mismatch).
      // Redirecting again would loop forever, so surface a DISTINCT error instead.
      // The code is deliberately NOT `unauthorised`, so the auth store treats it
      // as a real error state, not a perpetual "Redirecting…" (see auth.svelte.ts).
      void response.body?.cancel()
      const err: ApiError = {
        error: 'login_failed',
        message: 'Signed in, but the server refused access. Please try again later.',
      }
      throw err
    }
    // Record the redirect so an immediate repeat 401 is caught above, then hand off.
    markLoginRedirect()
    login(currentReturnTo())
    throw await toApiError(response)
  }

  if (!response.ok) {
    throw await toApiError(response)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json() as Promise<T>
}
