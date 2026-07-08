import { request } from './client'
import { assertListLogsResponse, type ListLogsResponse } from '../types/api'

/**
 * Fetches `GET /api/v1/logs` — the reference AUTHENTICATED resource. In `bff`
 * mode this rides the session cookie through the BFF, which attaches the bearer
 * server-side; the SPA never sees a token. A 401 triggers the client's login
 * seam; a 403 (authenticated but not authorised) surfaces as an `ApiError` the
 * caller renders in place. Response is guarded at the boundary before use.
 *
 * MUST send `cursor` (empty = first page). The Go API selects its response shape
 * by the PRESENCE of `?cursor` (userlog_handler.go: `if q.Has("cursor")`): with a
 * cursor it returns the wrapped `{ logs, next_cursor? }`; WITHOUT one it falls to
 * offset mode and returns a BARE ARRAY, which `assertListLogsResponse` rejects.
 * So a cursor-less request breaks against the real API on every call. `next_cursor`
 * is surfaced to callers for pagination (Home.svelte may ignore it for now).
 */
export async function listLogs(limit = 10): Promise<ListLogsResponse> {
  return assertListLogsResponse(
    await request<unknown>(`/api/v1/logs?cursor=&limit=${encodeURIComponent(limit)}`)
  )
}
