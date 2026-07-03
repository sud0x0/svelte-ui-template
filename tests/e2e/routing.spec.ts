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
})
