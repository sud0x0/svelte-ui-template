import { describe, expect, it } from 'vitest'
import {
  isApiError,
  assertHealthResponse,
  assertCurrentUser,
  assertListLogsResponse,
} from '../../src/lib/types/api'

const validLog = {
  id: 'l1',
  user_id: 'u1',
  date_and_time: '2026-07-07T09:00:00Z',
  log: 'x',
  created_at: '2026-07-07T09:00:00Z',
  updated_at: '2026-07-07T09:00:00Z',
}

describe('boundary guards', () => {
  it('isApiError narrows the envelope', () => {
    expect(isApiError({ error: 'x' })).toBe(true)
    expect(isApiError({ nope: 1 })).toBe(false)
    expect(isApiError(null)).toBe(false)
  })

  it('assertHealthResponse accepts valid and rejects invalid', () => {
    expect(assertHealthResponse({ status: 'ok' }).status).toBe('ok')
    expect(assertHealthResponse({ status: 'ok', version: '1.2.3' }).version).toBe('1.2.3')
    expect(() => assertHealthResponse({})).toThrow(/Malformed HealthResponse/)
    // A present-but-non-string `version` must be rejected, not silently accepted.
    expect(() => assertHealthResponse({ status: 'ok', version: 42 })).toThrow(
      /Malformed HealthResponse/
    )
  })

  it('assertCurrentUser accepts valid and rejects invalid', () => {
    expect(assertCurrentUser({ id: '1', displayName: 'n' }).id).toBe('1')
    expect(assertCurrentUser({ id: '1', displayName: 'n', roles: ['user'] }).roles).toEqual([
      'user',
    ])
    expect(() => assertCurrentUser({ id: '1' })).toThrow(/Malformed CurrentUser/)
    // `roles` present but not an array of strings must be rejected.
    expect(() => assertCurrentUser({ id: '1', displayName: 'n', roles: 'user' })).toThrow(
      /Malformed CurrentUser/
    )
    expect(() => assertCurrentUser({ id: '1', displayName: 'n', roles: [1, 2] })).toThrow(
      /Malformed CurrentUser/
    )
  })

  it('assertListLogsResponse accepts valid and rejects invalid', () => {
    expect(assertListLogsResponse({ logs: [validLog] }).logs[0]!.id).toBe('l1')
    expect(assertListLogsResponse({ logs: [], next_cursor: 'c1' }).next_cursor).toBe('c1')
    // Not an array of logs.
    expect(() => assertListLogsResponse({ logs: {} })).toThrow(/Malformed ListLogsResponse/)
    // A log entry missing a required string field.
    expect(() => assertListLogsResponse({ logs: [{ ...validLog, log: 42 }] })).toThrow(
      /Malformed ListLogsResponse/
    )
    // Present-but-non-string next_cursor.
    expect(() => assertListLogsResponse({ logs: [], next_cursor: 5 })).toThrow(
      /Malformed ListLogsResponse/
    )
  })
})
