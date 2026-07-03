import { request } from './client'
import { config } from '../config'
import { assertCurrentUser, type CurrentUser } from '../types/api'

// The auth seam — CONTRACT ONLY. Authentication is intentionally not
// implemented; this file ships the shape the future BFF will satisfy.
//
// TODO(auth): wire these to the BFF /auth/* endpoints when VITE_AUTH_MODE === 'bff'.
//   getCurrentUser() -> GET  /auth/me      (returns the session user)
//   login(returnTo)  -> GET  /auth/login   (BFF builds the OIDC Auth Code + PKCE
//                                            request and 302s to the IdP)
//   logout()         -> POST /auth/logout  (BFF clears the __Host- session cookie,
//                                            then RP-initiated logout at the IdP)
//
// No tokens, no PKCE, no state/nonce, no OIDC library here — all of that is the
// Go BFF's job. See README "Authentication" and .claude/skills/auth-integration.

/**
 * The static user shown in disabled mode so guarded views render during
 * development. NOT a real session — purely a dev placeholder.
 */
export const DEV_USER: CurrentUser = {
  id: '00000000-0000-0000-0000-000000000000',
  displayName: 'Local Developer',
  roles: ['user'],
}

/**
 * Resolves the current user.
 * - `bff` mode: calls `GET /auth/me`; a 401 there means "not signed in".
 * - `disabled` mode: resolves {@link DEV_USER} so the app is usable with no backend.
 */
export async function getCurrentUser(): Promise<CurrentUser> {
  if (config.authMode === 'bff') {
    // TODO(auth): the BFF resolves the user from its server-side tokens and
    // returns this profile. The SPA never sees a token.
    return assertCurrentUser(await request<unknown>('/auth/me'))
  }
  return Promise.resolve(DEV_USER)
}

/**
 * Begins a login. `returnTo` is the path to come back to after the IdP round
 * trip (defaults to the current location).
 * - `bff` mode: navigates to the BFF `/auth/login`, which owns the OIDC flow.
 * - `disabled` mode: documented no-op — there is nothing to log in to yet.
 */
export function login(returnTo?: string): void {
  if (config.authMode === 'bff') {
    // TODO(auth): hand off to the BFF. It builds the Authorization Code + PKCE
    // (S256) request with `state` + `nonce` and 302s to the IdP discovered via
    // .well-known/openid-configuration.
    const target = returnTo ?? location.pathname + location.search
    window.location.assign(`/auth/login?return_to=${encodeURIComponent(target)}`)
    return
  }
  // disabled mode: no-op. `returnTo` is still threaded through so the return-path
  // plumbing is exercised today and bff becomes a drop-in.
  void returnTo
}

/**
 * Logs out.
 * - `bff` mode: `POST /auth/logout` (CSRF header attaches automatically via the
 *   client), then returns to the app root after the BFF clears the session.
 * - `disabled` mode: documented no-op.
 */
export async function logout(): Promise<void> {
  if (config.authMode === 'bff') {
    // TODO(auth): BFF clears the __Host- session cookie and performs
    // RP-initiated logout at the IdP end_session_endpoint.
    await request<void>('/auth/logout', { method: 'POST' })
    window.location.assign('/')
    return
  }
  // disabled mode: no-op.
}
