import { describe, expect, it } from 'vitest'
import { parseApiError, errorMessage } from '../../src/lib/utils/errors'

describe('parseApiError', () => {
  it('passes an ApiError envelope through unchanged', () => {
    expect(parseApiError({ error: 'validation', message: 'bad' })).toEqual({
      error: 'validation',
      message: 'bad',
    })
  })

  it('wraps a thrown Error', () => {
    expect(parseApiError(new Error('boom'))).toEqual({ error: 'unexpected', message: 'boom' })
  })

  it('handles unknown values', () => {
    expect(parseApiError('nope')).toEqual({
      error: 'unexpected',
      message: 'An unexpected error occurred',
    })
  })
})

describe('errorMessage', () => {
  it('prefers message, then falls back to error', () => {
    expect(errorMessage({ error: 'e', message: 'm' })).toBe('m')
    expect(errorMessage({ error: 'e' })).toBe('e')
  })
})
