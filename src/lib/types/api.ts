// The API contract shared with the Go backend (github.com/sud0x0/go-api-template).
//
// These types ARE the boundary: the API client narrows untrusted JSON to these
// shapes (see lib/api/client.ts and the guard helpers below) before any
// component sees the data. Keep them in lockstep with the Go side.

/**
 * Error envelope returned by the Go API: `{"error","message"}`.
 * `error` is a bounded, machine-readable type (e.g. `"not_found"`,
 * `"validation"`, `"unauthorised"`); `message` is optional human-readable detail.
 */
export interface ApiError {
  error: string
  message?: string
}

/** Liveness/health payload from `GET /health`. */
export interface HealthResponse {
  /** e.g. `"ok"`. */
  status: string
  /** Optional build version the backend reports. */
  version?: string
}

/**
 * The authenticated user the BFF returns from `GET /auth/me`.
 *
 * SECURITY: the SPA holds ONLY this non-sensitive profile, in memory. It never
 * holds an access, refresh, or ID token — those live server-side in the BFF.
 * Do not add token fields here. (.claude/rules/security.md)
 */
export interface CurrentUser {
  id: string
  displayName: string
  roles?: string[]
}

/**
 * A user log entry from the Go API's reference resource
 * (go-api-template internal/userlog/userlog_model.go). Timestamps are RFC3339
 * strings as Go marshals `time.Time`.
 */
export interface Log {
  id: string
  user_id: string
  date_and_time: string
  log: string
  created_at: string
  updated_at: string
}

/**
 * `GET /api/v1/logs` in cursor mode: `{ logs, next_cursor? }`. (The Go API also
 * has an offset mode that returns a bare array; the SPA uses the wrapped cursor
 * shape — the BFF/stub returns it — so a component never branches on two shapes.)
 */
export interface ListLogsResponse {
  logs: Log[]
  next_cursor?: string
}

// --- Boundary guards --------------------------------------------------------
// Narrow untrusted JSON to the contract above. The client calls these so a
// malformed response is caught at the edge, not three components deep.

/** Type guard for the API error envelope. */
export function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as Record<string, unknown>).error === 'string'
  )
}

/** Narrows a parsed `/health` body, throwing if it does not match the contract. */
export function assertHealthResponse(value: unknown): HealthResponse {
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>
    // `version` is optional, but if present it MUST be a string — a present-but-
    // non-string version is a malformed response, not a silently-accepted one.
    if (
      typeof v.status === 'string' &&
      (v.version === undefined || typeof v.version === 'string')
    ) {
      return value as HealthResponse
    }
  }
  throw new Error('Malformed HealthResponse')
}

/** Narrows a parsed `/auth/me` body, throwing if it does not match the contract. */
export function assertCurrentUser(value: unknown): CurrentUser {
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>
    // `roles` is optional, but if present it MUST be an array of strings — a
    // present-but-invalid roles field is a malformed response.
    const rolesOk =
      v.roles === undefined ||
      (Array.isArray(v.roles) && v.roles.every((r) => typeof r === 'string'))
    if (typeof v.id === 'string' && typeof v.displayName === 'string' && rolesOk) {
      return value as CurrentUser
    }
  }
  throw new Error('Malformed CurrentUser')
}

function isLog(value: unknown): value is Log {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.user_id === 'string' &&
    typeof v.date_and_time === 'string' &&
    typeof v.log === 'string' &&
    typeof v.created_at === 'string' &&
    typeof v.updated_at === 'string'
  )
}

/** Narrows a parsed `/api/v1/logs` body, throwing if it does not match the contract. */
export function assertListLogsResponse(value: unknown): ListLogsResponse {
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>
    // `next_cursor` is optional, but if present it MUST be a string.
    const cursorOk = v.next_cursor === undefined || typeof v.next_cursor === 'string'
    if (Array.isArray(v.logs) && v.logs.every(isLog) && cursorOk) {
      return value as ListLogsResponse
    }
  }
  throw new Error('Malformed ListLogsResponse')
}
