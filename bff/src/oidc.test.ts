import { describe, expect, it } from 'vitest'
import { accessTokenExpiryMs, DEFAULT_ACCESS_TOKEN_LIFETIME_S } from './oidc.ts'

// Access-token expiry mapping (item 8). A missing `expires_in` must NOT map the
// expiry to "now" (which forces an immediate refresh / 401 loop right after
// login) — it falls back to a conservative default lifetime.
describe('accessTokenExpiryMs', () => {
  it('uses the IdP-provided expires_in when present', () => {
    expect(accessTokenExpiryMs(3600, 1000)).toBe(1000 + 3600 * 1000)
    expect(accessTokenExpiryMs(0, 1000)).toBe(1000) // an explicit 0 is honoured
  })

  it('falls back to a conservative default when expires_in is omitted', () => {
    expect(accessTokenExpiryMs(undefined, 1000)).toBe(1000 + DEFAULT_ACCESS_TOKEN_LIFETIME_S * 1000)
    expect(DEFAULT_ACCESS_TOKEN_LIFETIME_S).toBe(300)
  })
})
