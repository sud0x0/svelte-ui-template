import { isApiError, type ApiError } from '../types/api'

/**
 * Normalises any thrown value into the API error envelope so components can
 * render a single, predictable shape. The client throws `ApiError` objects;
 * unexpected throws (network failure, bugs) are wrapped here.
 */
export function parseApiError(error: unknown): ApiError {
  if (isApiError(error)) {
    return error
  }
  if (error instanceof Error) {
    return { error: 'unexpected', message: error.message }
  }
  return { error: 'unexpected', message: 'An unexpected error occurred' }
}

/** Human-readable string for display, preferring `message` then `error`. */
export function errorMessage(error: unknown): string {
  const parsed = parseApiError(error)
  return parsed.message ?? parsed.error
}
