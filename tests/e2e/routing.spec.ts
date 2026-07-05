import { expect, test } from '@playwright/test'

// Runs against the production build served by `vite preview` (auth disabled).
test.describe('routing + SPA fallback', () => {
  test('deep link to /login resolves directly', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  })

  test('an unmatched path renders NotFound (index.html served by SPA fallback)', async ({
    page,
  }) => {
    const response = await page.goto('/totally/unknown/path')
    // The static host serves index.html (200) for non-file routes; the client
    // router then renders the 404 view.
    expect(response?.status()).toBe(200)
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible()
  })

  test('back and forward navigation work', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()

    await page.getByRole('link', { name: 'Login' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/login')

    await page.goBack()
    await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()

    await page.goForward()
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  })

  test('marks the active nav link with aria-current="page"', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page')
    // Non-active links must not carry aria-current.
    await expect(page.getByRole('link', { name: 'Login' })).not.toHaveAttribute('aria-current')

    await page.getByRole('link', { name: 'Login' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Login' })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current')
  })

  test('moves focus to <main> after a client-side navigation', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()

    await page.getByRole('link', { name: 'Login' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    // Router moves focus to the static <main> so assistive tech announces the
    // new screen (BBC GEL routing guidance).
    await expect(page.locator('main#main')).toBeFocused()
  })

  test('a Ctrl/Cmd-modified click opens a new tab instead of same-tab SPA nav', async ({
    page,
    context,
  }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible()

    // ControlOrMeta-click must NOT be hijacked — the browser opens a new page and
    // the original stays put on /.
    const pagePromise = context.waitForEvent('page')
    await page.getByRole('link', { name: 'Login' }).click({ modifiers: ['ControlOrMeta'] })
    const newPage = await pagePromise
    // The new tab starts at about:blank and then navigates to the link's href —
    // wait for that URL rather than racing it.
    await newPage.waitForURL(/\/login$/)

    expect(new URL(newPage.url()).pathname).toBe('/login')
    expect(new URL(page.url()).pathname).toBe('/')
    await newPage.close()
  })
})
