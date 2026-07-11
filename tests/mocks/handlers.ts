import { http, HttpResponse } from 'msw'

// Default MSW handlers — the happy-path API boundary the app talks to with no
// real backend. Individual tests add/override with `worker.use(...)`.
export const handlers = [
  // Mirrors go-api-template's real /health shape: `{ status: 'healthy' }` (NOT
  // `{ status: 'ok' }`). Keeping the mock faithful to the real API stops a drift
  // where the SPA renders a value the backend never returns (fix 4).
  http.get('/health', () => HttpResponse.json({ status: 'healthy' })),

  // The BFF /auth/me. Used only under VITE_AUTH_MODE='bff'; in disabled mode the
  // app never calls it (getCurrentUser resolves the dev user locally).
  http.get('/auth/me', () => HttpResponse.json({ id: 'u-test', displayName: 'Test User' })),

  // The reference authenticated resource. Individual tests override with
  // worker.use(...) to exercise the empty / 403 / error states.
  //
  // Mirrors the REAL Go API contract (userlog_handler.go): the response shape is
  // chosen by the PRESENCE of `?cursor`. With a cursor -> the wrapped
  // `{ logs, next_cursor? }`; WITHOUT one -> offset mode returns a BARE ARRAY.
  // The client always sends `cursor`; returning a bare array for a cursor-less
  // request keeps the mock honest so the item-1 regression cannot hide again.
  http.get('/api/v1/logs', ({ request }) => {
    const entry = {
      id: 'log-1',
      user_id: 'u-test',
      date_and_time: '2026-07-07T09:00:00Z',
      log: 'reference log entry',
      created_at: '2026-07-07T09:00:00Z',
      updated_at: '2026-07-07T09:00:00Z',
    }
    if (!new URL(request.url).searchParams.has('cursor')) {
      return HttpResponse.json([entry]) // offset mode: bare array
    }
    return HttpResponse.json({ logs: [entry] }) // cursor mode: wrapped
  }),
]
