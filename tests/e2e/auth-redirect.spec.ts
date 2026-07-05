import { expect, test } from '@playwright/test'

// Runs against a dev server built with VITE_AUTH_MODE=bff (see playwright.config
// `auth-seam` project). The BFF endpoints are mocked at the network layer, so no
// real backend is needed — this proves the auth-redirect seam, not a real IdP.
test.describe('auth-redirect seam (bff mode)', () => {
  test('unauthenticated visit to a guarded route redirects to login, preserving returnTo', async ({
    page,
  }) => {
    // The session is not established: /auth/me returns 401.
    await page.route('**/auth/me', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: '{"error":"unauthorised"}',
      })
    )

    // Capture the BFF login hand-off and serve a stub so the page settles.
    let loginUrl: string | null = null
    await page.route('**/auth/login*', (route) => {
      loginUrl = route.request().url()
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>IdP login</h1>' })
    })

    // Visit the guarded Home route.
    await page.goto('/')

    await expect.poll(() => loginUrl).not.toBeNull()
    // The poll above guarantees loginUrl is set by the time we get here.
    const url = new URL(loginUrl!)
    expect(url.pathname).toBe('/auth/login')
    // returnTo preserves the intended destination.
    expect(url.searchParams.get('return_to')).toBe('/')
  })
})
