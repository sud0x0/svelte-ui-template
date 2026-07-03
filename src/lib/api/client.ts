import type { ApiError } from '../types/api'
import { login } from './auth'

// The single fetch wrapper. Every network call in the app goes through here —
// no route or component calls `fetch` directly. It owns three auth-seam hooks
// that exist TODAY so the future BFF switch is trivial:
//
//   1. credentials: 'include'  — always send the (future) HttpOnly session
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

async function toApiError(response: Response): Promise<ApiError> {
  const text = await response.text()
  try {
    const parsed: unknown = JSON.parse(text)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).error === 'string'
    ) {
      return parsed as ApiError
    }
  } catch {
    // fall through to a synthesised envelope
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
  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
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
    // TODO(auth): this is the single place the SPA reacts to "not authenticated".
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
