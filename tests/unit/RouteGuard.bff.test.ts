import { describe, expect, it, vi } from 'vitest'

// Force bff mode for this whole file (hoisted above the imports below by Vitest).
//
// Unlike the old version of this test — which fully mocked getCurrentUser and
// let the GUARD call login — we now exercise the REAL client path: getCurrentUser
// goes through the real `request()`, hits an MSW 401 for /auth/me, and the
// CLIENT's centralised 401 -> login(returnTo) seam (lib/api/client.ts) fires. The
// guard no longer calls login itself (single owner = the client), so this proves
// the seam that actually ships.
//
// We can't cleanly `importOriginal` the auth module: partial mocks crash the page
// on the auth↔client circular import in browser mode (see decisions.md #8), and
// the real login() calls `window.location.assign`, which is not reliably spyable
// in the browser. So we factory-mock auth with `login` as an observable spy while
// reconstructing bff getCurrentUser to run the REAL `request()` — identical to the
// real getCurrentUser, so the real client 401 seam is what's under test.
vi.mock('../../src/lib/config', () => ({ config: { authMode: 'bff' } }))
vi.mock('../../src/lib/api/auth', () => ({
  login: vi.fn(),
  logout: vi.fn(),
  getCurrentUser: async () => {
    const { request } = await import('../../src/lib/api/client')
    const { assertCurrentUser } = await import('../../src/lib/types/api')
    return assertCurrentUser(await request<unknown>('/auth/me'))
  },
  DEV_USER: { id: 'dev', displayName: 'dev' },
}))

import { render } from 'vitest-browser-svelte'
import { http, HttpResponse } from 'msw'
import { worker } from '../mocks/setup'
import { login } from '../../src/lib/api/auth'
import GuardHarness from './fixtures/GuardHarness.svelte'

describe('RouteGuard (bff mode, real client 401 seam)', () => {
  it('hands off to login exactly once with the captured returnTo on a 401 from /auth/me', async () => {
    worker.use(http.get('/auth/me', () => new HttpResponse(null, { status: 401 })))
    history.replaceState({}, '', '/secret?ref=1')

    render(GuardHarness)

    // The CLIENT (not the guard) fires login with the returnTo it captured from
    // the current location. Exactly one owner => exactly one hand-off.
    await vi.waitFor(() => expect(login).toHaveBeenCalledWith('/secret?ref=1'))
    expect(login).toHaveBeenCalledTimes(1)
  })
})
