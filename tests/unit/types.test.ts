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
    expect(() => assertHealthResponse({})).toThrow(/Malformed HealthResponse/)
  })

  it('assertCurrentUser accepts valid and rejects invalid', () => {
    expect(assertCurrentUser({ id: '1', displayName: 'n' }).id).toBe('1')
    expect(() => assertCurrentUser({ id: '1' })).toThrow(/Malformed CurrentUser/)
  })
})
