import type { CurrentUser } from '../types/api'
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

let user = $state<CurrentUser | null>(null)
let status = $state<'idle' | 'loading' | 'ready' | 'error'>('idle')

/** The current profile, or `null` when not resolved / signed out. */
export function authUser(): CurrentUser | null {
  return user
}

/** Lifecycle of the user resolution. */
export function authStatus(): 'idle' | 'loading' | 'ready' | 'error' {
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
  } catch {
    user = null
    status = 'error'
  }
}

/** Clears the in-memory profile (e.g. after logout). */
export function clearAuthUser(): void {
  user = null
  status = 'idle'
}
