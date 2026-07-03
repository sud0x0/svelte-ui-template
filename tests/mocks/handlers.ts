import { http, HttpResponse } from 'msw'

// Default MSW handlers — the happy-path API boundary the app talks to with no
// real backend. Individual tests add/override with `worker.use(...)`.
export const handlers = [
  http.get('/health', () => HttpResponse.json({ status: 'ok', version: 'test' })),

  // The BFF /auth/me. Used only under VITE_AUTH_MODE='bff'; in disabled mode the
  // app never calls it (getCurrentUser resolves the dev user locally).
  http.get('/auth/me', () => HttpResponse.json({ id: 'u-test', displayName: 'Test User' })),
]
