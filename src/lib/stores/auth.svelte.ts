import { isApiError, type CurrentUser } from '../types/api'
import { getCurrentUser } from '../api/auth'

// Auth state — runes, in-memory ONLY.
//
// SECURITY: never persisted. No localStorage/sessionStorage, no cookie written
// here. Holds the non-sensitive CurrentUser profile, never a token of any kind.
// (.claude/rules/security.md — "Never put session material in Web Storage".)
//
// Runes-first idiom: module-level `$state` exposed through plain accessor
// functions, not the legacy `writable` store API. Reading an accessor inside a
// component's template or `$derived` tracks it reactively. (decisions.md)

/**
 * Resolution lifecycle. `unauthenticated` and `error` are DISTINCT failure modes
 * (item 5): `unauthenticated` is a 401 where the API client has already fired the
 * login(returnTo) redirect seam, so a redirect is genuinely in flight; `error` is
 * any other backend failure (BFF/API down, timeout, network) with NO redirect.
 */
export type AuthStatus = 'idle' | 'loading' | 'ready' | 'unauthenticated' | 'error'

let user = $state<CurrentUser | null>(null)
let status = $state<AuthStatus>('idle')

/** The current profile, or `null` when not resolved / signed out. */
export function authUser(): CurrentUser | null {
  return user
}

/** Lifecycle of the user resolution. */
export function authStatus(): AuthStatus {
  return status
}

/** True once a profile is present. */
export function isAuthenticated(): boolean {
  return user !== null
}

/**
 * Resolves the current user via the auth API. In disabled mode this yields the
 * dev user; in bff mode it calls `GET /auth/me`. Idempotent enough to call from
 * a guard effect — it just re-fetches.
 */
export async function loadCurrentUser(): Promise<void> {
  status = 'loading'
  try {
    user = await getCurrentUser()
    status = 'ready'
  } catch (err) {
    user = null
    // A 401 (`unauthorised` envelope) means "not signed in": the API client has
    // ALREADY fired login(returnTo) (client.ts is the single owner of that seam),
    // so a redirect is in flight -> `unauthenticated`. ANY other failure (502,
    // timeout, network) is a real backend `error` with no redirect, so the guard
    // can offer Retry instead of a permanent fake "Redirecting…" (item 5).
    status = isApiError(err) && err.error === 'unauthorised' ? 'unauthenticated' : 'error'
  }
}

/** Clears the in-memory profile (e.g. after logout). */
export function clearAuthUser(): void {
  user = null
  status = 'idle'
}
