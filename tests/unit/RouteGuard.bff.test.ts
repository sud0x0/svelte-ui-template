import { beforeEach, describe, expect, it, vi } from 'vitest'

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
import { page } from 'vitest/browser'
import { http, HttpResponse } from 'msw'
import { worker } from '../mocks/setup'
import { login } from '../../src/lib/api/auth'
import { clearAuthUser } from '../../src/lib/stores/auth.svelte'
import GuardHarness from './fixtures/GuardHarness.svelte'

// The real Go/BFF 401 envelope for /auth/me (see bff/src/http.ts `unauthorised`).
const UNAUTHORISED_401 = () =>
  HttpResponse.json({ error: 'unauthorised', message: 'no active session' }, { status: 401 })

describe('RouteGuard (bff mode, real client 401 seam)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The auth store is a module-level singleton; reset it to 'idle' so each
    // test's guard effect actually re-resolves through its own MSW handler.
    clearAuthUser()
    history.replaceState({}, '', '/secret?ref=1')
  })

  it('hands off to login exactly once with the captured returnTo on a 401 from /auth/me', async () => {
    worker.use(http.get('/auth/me', UNAUTHORISED_401))

    render(GuardHarness)

    // The CLIENT (not the guard) fires login with the returnTo it captured from
    // the current location. Exactly one owner => exactly one hand-off.
    await vi.waitFor(() => expect(login).toHaveBeenCalledWith('/secret?ref=1'))
    expect(login).toHaveBeenCalledTimes(1)
  })

  it('shows the "Redirecting to sign in…" notice on a 401 (redirect genuinely in flight)', async () => {
    worker.use(http.get('/auth/me', UNAUTHORISED_401))

    render(GuardHarness)

    await expect.element(page.getByText(/redirecting to sign in/i)).toBeVisible()
  })

  it('on a backend error (502) shows a real error + Retry, does NOT claim to redirect, and never calls login', async () => {
    worker.use(
      http.get('/auth/me', () => HttpResponse.json({ error: 'bad_gateway' }, { status: 502 }))
    )

    render(GuardHarness)

    // Real error surface with a Retry action — never the fake "Redirecting…".
    await expect.element(page.getByRole('button', { name: /retry/i })).toBeVisible()
    await expect.element(page.getByText(/couldn't reach the server/i)).toBeVisible()
    expect(page.getByText(/redirecting to sign in/i).elements()).toHaveLength(0)
    // A 502 is not a 401, so the client's login seam must NOT fire.
    expect(login).not.toHaveBeenCalled()

    // Retry re-resolves; once the backend recovers, the guarded content renders.
    worker.use(http.get('/auth/me', () => HttpResponse.json({ id: 'u', displayName: 'U' })))
    await page.getByRole('button', { name: /retry/i }).click()
    await expect.element(page.getByTestId('guarded')).toBeVisible()
  })
})
