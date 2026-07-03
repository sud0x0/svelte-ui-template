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
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).status === 'string'
  ) {
    return value as HealthResponse
  }
  throw new Error('Malformed HealthResponse')
}

/** Narrows a parsed `/auth/me` body, throwing if it does not match the contract. */
export function assertCurrentUser(value: unknown): CurrentUser {
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    typeof (value as Record<string, unknown>).displayName === 'string'
  ) {
    return value as CurrentUser
  }
  throw new Error('Malformed CurrentUser')
}
