import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import GuardHarness from './fixtures/GuardHarness.svelte'

// Runs with the default VITE_AUTH_MODE (disabled).
describe('RouteGuard (disabled mode)', () => {
  it('is pass-through: resolves the dev user and renders children', async () => {
    render(GuardHarness)
    await expect.element(page.getByTestId('guarded')).toBeVisible()
  })
})
