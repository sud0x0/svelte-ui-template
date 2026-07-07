import { expect, test, type Page } from '@playwright/test'

// End-to-end against the REAL BFF (a confidential OIDC client) driving a real
// stub IdP and a real stub upstream API. Proves the whole architecture: the
// browser logs in through the IdP, the BFF holds the tokens, the proxy attaches
// the bearer, and the browser only ever holds a __Host- session cookie it can't
// read. See tests/e2e/stubs/idp-and-api.mjs and playwright.config.ts.

const STUB = 'http://localhost:4199'

// Serial: the stub has a little shared state (logs status) that the 403 test
// flips, so tests must not interleave.
test.describe.configure({ mode: 'serial' })

/** Logs in through the stub IdP's login page and lands on Home. */
async function loginToHome(page: Page): Promise<void> {
  await page.goto('/')
  // Guard -> /auth/me 401 -> client redirects to /auth/login -> BFF 302 -> the
  // stub IdP login page. Click "Sign in".
  await page.getByRole('link', { name: /sign in as ada/i }).click()
  // consent -> /auth/callback -> session -> Home.
  await expect(page.getByRole('heading', { name: /welcome, ada lovelace/i })).toBeVisible()
}

test.beforeEach(async ({ request }) => {
  await request.get(`${STUB}/_control/reset`)
})

test('logs in through the IdP, proxies logs with the server-side bearer, keeps the session HttpOnly, and logs out', async ({
  page,
  context,
}) => {
  await page.goto('/')
  // Signed out first: the IdP login page, not the app.
  await expect(page.getByRole('link', { name: /sign in as ada/i })).toBeVisible()
  await page.getByRole('link', { name: /sign in as ada/i }).click()

  // Home shows the profile the BFF resolved from the ID token.
  await expect(page.getByRole('heading', { name: /welcome, ada lovelace/i })).toBeVisible()
  // The logs list rendered — proving the proxy attached the access token (the
  // stub API returns data ONLY for the exact bearer it minted).
  await expect(page.getByText('proxied log entry via BFF')).toBeVisible()

  // The csrf cookie is readable by JS; the session cookie is NOT (HttpOnly).
  // (String form of evaluate so the E2E tsconfig needs no DOM lib.)
  const docCookie = (await page.evaluate('document.cookie')) as string
  expect(docCookie).toContain('csrf=')
  expect(docCookie).not.toContain('__Host-session')

  const cookies = await context.cookies()
  const session = cookies.find((c) => c.name === '__Host-session')
  expect(session, 'session cookie present in the jar').toBeDefined()
  expect(session?.httpOnly).toBe(true)
  const csrf = cookies.find((c) => c.name === 'csrf')
  expect(csrf?.httpOnly).toBe(false)

  // Log out: BFF clears cookies + returns the RP-initiated logout URL; the SPA
  // follows it (IdP end_session) and lands back signed out.
  await page.getByRole('button', { name: /log out/i }).click()
  await expect(page.getByRole('link', { name: /sign in as ada/i })).toBeVisible()
  const afterCookies = await context.cookies()
  expect(afterCookies.find((c) => c.name === '__Host-session')).toBeUndefined()
})

test('an unsafe /api write without the CSRF header is rejected by the BFF, and never reaches the API', async ({
  page,
  request,
}) => {
  await loginToHome(page)

  // A raw fetch (NOT via the client) omits x-csrf-token. The browser still sends
  // the session cookie, so the BFF has a session — but the signed double-submit
  // check fails, so it answers 403 and never proxies.
  const status = await page.evaluate(async () => {
    const res = await fetch('/api/v1/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    return res.status
  })
  expect(status).toBe(403)

  const state = (await request.get(`${STUB}/_control/state`).then((r) => r.json())) as {
    logsPostCount: number
  }
  expect(state.logsPostCount).toBe(0) // the stub API never saw the write
})

test('a 403 from the API renders the in-place "not authorised" notice without redirecting', async ({
  page,
  request,
}) => {
  await request.get(`${STUB}/_control/logs-status?code=403`)
  await loginToHome(page)

  await expect(page.getByText(/not authorised to view logs/i)).toBeVisible()
  // Still on Home — a 403 must NOT trigger the login redirect (that is only 401).
  await expect(page.getByRole('heading', { name: /welcome, ada lovelace/i })).toBeVisible()
})

test('the token endpoint rejects a wrong client secret (a green login proves confidential-client auth)', async ({
  request,
}) => {
  const res = await request.post(`${STUB}/token`, {
    form: {
      grant_type: 'authorization_code',
      client_id: 'svelte-ui-bff',
      client_secret: 'WRONG-SECRET',
      code: 'anything',
      code_verifier: 'anything',
    },
  })
  expect(res.status()).toBe(401)
  expect((await res.json()).error).toBe('invalid_client')
})
