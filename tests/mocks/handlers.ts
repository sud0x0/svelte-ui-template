import { http, HttpResponse } from 'msw'

// Default MSW handlers — the happy-path API boundary the app talks to with no
// real backend. Individual tests add/override with `worker.use(...)`.
export const handlers = [
  http.get('/health', () => HttpResponse.json({ status: 'ok', version: 'test' })),

  // The BFF /auth/me. Used only under VITE_AUTH_MODE='bff'; in disabled mode the
  // app never calls it (getCurrentUser resolves the dev user locally).
  http.get('/auth/me', () => HttpResponse.json({ id: 'u-test', displayName: 'Test User' })),

  // The reference authenticated resource. Individual tests override with
  // worker.use(...) to exercise the empty / 403 / error states.
  http.get('/api/v1/logs', () =>
    HttpResponse.json({
      logs: [
        {
          id: 'log-1',
          user_id: 'u-test',
          date_and_time: '2026-07-07T09:00:00Z',
          log: 'reference log entry',
          created_at: '2026-07-07T09:00:00Z',
          updated_at: '2026-07-07T09:00:00Z',
        },
      ],
    })
  ),
]
