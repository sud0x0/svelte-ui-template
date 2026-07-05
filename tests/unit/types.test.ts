import { describe, expect, it } from 'vitest'
import { isApiError, assertHealthResponse, assertCurrentUser } from '../../src/lib/types/api'

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
})
