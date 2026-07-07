import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { http, HttpResponse } from 'msw'
import { worker } from '../mocks/setup'
import { loadCurrentUser, clearAuthUser } from '../../src/lib/stores/auth.svelte'
import Home from '../../src/routes/Home.svelte'

// The "Recent logs" section on Home. In disabled mode getCurrentUser resolves the
// dev user, so the section renders; MSW drives its three states. (The default
// /health + /api/v1/logs handlers live in tests/mocks/handlers.ts.)
describe('Home — recent logs section', () => {
  beforeEach(async () => {
    // A user must be present for the section to render (Home is guarded).
    await loadCurrentUser()
  })
  afterEach(() => {
    clearAuthUser()
  })

  it('renders the list when logs are returned', async () => {
    worker.use(
      http.get('/api/v1/logs', () =>
        HttpResponse.json({
          logs: [
            {
              id: 'log-1',
              user_id: 'u-1',
              date_and_time: '2026-07-07T09:00:00Z',
              log: 'first entry',
              created_at: '2026-07-07T09:00:00Z',
              updated_at: '2026-07-07T09:00:00Z',
            },
          ],
        })
      )
    )
    render(Home)
    await expect.element(page.getByText('first entry')).toBeVisible()
  })

  it('shows the empty state when there are no logs', async () => {
    worker.use(http.get('/api/v1/logs', () => HttpResponse.json({ logs: [] })))
    render(Home)
    await expect.element(page.getByText('No logs yet.')).toBeVisible()
  })

  it('shows the distinct "not authorised" notice on 403 and does not redirect', async () => {
    const before = location.href
    worker.use(
      http.get('/api/v1/logs', () =>
        HttpResponse.json({ error: 'forbidden', message: 'nope' }, { status: 403 })
      )
    )
    render(Home)
    await expect.element(page.getByText(/not authorised to view logs/i)).toBeVisible()
    expect(location.href).toBe(before)
  })
})
