import { describe, expect, it, vi } from 'vitest'

// Force bff mode for this whole file, and replace the auth module with a plain
// factory (both hoisted above the imports below by Vitest). `importOriginal`
// partial mocks crash the page on the auth↔client circular import in browser
// mode, so the mock's getCurrentUser reproduces the real bff behaviour — it
// fetches /auth/me and throws on 401 — while `login` is an observable spy.
vi.mock('../../src/lib/config', () => ({ config: { authMode: 'bff' } }))
vi.mock('../../src/lib/api/auth', () => ({
  login: vi.fn(),
  logout: vi.fn(),
  getCurrentUser: async () => {
    const res = await fetch('/auth/me', { credentials: 'include' })
    if (!res.ok) throw { error: 'unauthorised' }
    return res.json()
  },
  DEV_USER: { id: 'dev', displayName: 'dev' },
}))

import { render } from 'vitest-browser-svelte'
import { http, HttpResponse } from 'msw'
import { worker } from '../mocks/setup'
import { login } from '../../src/lib/api/auth'
import GuardHarness from './fixtures/GuardHarness.svelte'

describe('RouteGuard (bff mode stub)', () => {
  it('captures the intended destination as returnTo and hands off to login on 401', async () => {
    worker.use(http.get('/auth/me', () => new HttpResponse(null, { status: 401 })))
    history.replaceState({}, '', '/secret?ref=1')

    render(GuardHarness)

    // The guard's error effect fires login with the captured returnTo. Proves
    // the return-path plumbing works.
    await vi.waitFor(() => expect(login).toHaveBeenCalledWith('/secret?ref=1'))
  })
})
