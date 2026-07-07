import { request } from './client'
import { assertListLogsResponse, type ListLogsResponse } from '../types/api'

/**
 * Fetches `GET /api/v1/logs` — the reference AUTHENTICATED resource. In `bff`
 * mode this rides the session cookie through the BFF, which attaches the bearer
 * server-side; the SPA never sees a token. A 401 triggers the client's login
 * seam; a 403 (authenticated but not authorised) surfaces as an `ApiError` the
 * caller renders in place. Response is guarded at the boundary before use.
 */
export async function listLogs(limit = 10): Promise<ListLogsResponse> {
  return assertListLogsResponse(
    await request<unknown>(`/api/v1/logs?limit=${encodeURIComponent(limit)}`)
  )
}
