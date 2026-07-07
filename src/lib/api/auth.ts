import { request } from './client'
import { config } from '../config'
import { navigate } from '../stores/router.svelte'
import { assertCurrentUser, type CurrentUser } from '../types/api'

// The auth seam. In `bff` mode these three functions are wired to the shipped
// BFF's /auth/* endpoints; in `disabled` mode they are inert (dev user, no-ops).
// The SPA holds NO tokens either way — that stays true whichever mode is active.
//
//   getCurrentUser() -> GET  /auth/me      (the BFF returns the session user)
//   login(returnTo)  -> GET  /auth/login   (the BFF builds the OIDC Auth Code +
//                                            PKCE request and 302s to the IdP)
//   logout()         -> POST /auth/logout  (the BFF clears the __Host- session
//                                            cookie, then RP-initiated IdP logout)
//
// No tokens, no PKCE, no state/nonce, no OIDC library here — all of that is the
// BFF's job (bff/src/). See README "Authentication" and
// .claude/skills/auth-integration, and decisions.md #16.

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
    // The BFF resolves the user from its server-side tokens and returns this
    // profile (bff/src/routes/auth.ts, /auth/me). The SPA never sees a token.
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
    // Hand off to the BFF. It builds the Authorization Code + PKCE (S256) request
    // with `state` + `nonce` and 302s to the IdP discovered via
    // .well-known/openid-configuration (bff/src/routes/auth.ts, /auth/login).
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
 * - `bff` mode: `POST /auth/logout` (the client attaches the CSRF header). The
 *   BFF clears the `__Host-` session + `csrf` cookies and, when the IdP supports
 *   RP-initiated logout, replies `200 { logout_url }`. We follow that URL as a
 *   full-page navigation (it leaves our origin for the IdP's
 *   `end_session_endpoint`). With no `end_session_endpoint` the BFF replies `204`
 *   and we just return to the app root via the client-side router.
 * - `disabled` mode: documented no-op.
 */
export async function logout(): Promise<void> {
  if (config.authMode === 'bff') {
    // 204 -> request() resolves undefined; 200 -> the { logout_url } envelope.
    const result = await request<{ logout_url?: string } | undefined>('/auth/logout', {
      method: 'POST',
    })
    if (result?.logout_url !== undefined) {
      window.location.assign(result.logout_url)
    } else {
      navigate('/')
    }
    return
  }
  // disabled mode: no-op.
}
