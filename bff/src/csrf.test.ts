import { describe, expect, it } from 'vitest'
import {
  csrfToken,
  verifyCsrfToken,
  isCrossSiteRequest,
  guardUnsafeRequest,
  serializeCsrfCookie,
  clearCsrfCookie,
} from './csrf.ts'

const SECRET = 'test-secret-at-least-32-bytes-long!!'
const SID = 'session-id-abc'

describe('signed double-submit CSRF (security.md rule 2)', () => {
  it('produces a deterministic base64url HMAC bound to the session id', () => {
    const t = csrfToken(SECRET, SID)
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(csrfToken(SECRET, SID)).toBe(t) // deterministic
    expect(csrfToken(SECRET, 'other-session')).not.toBe(t) // session-bound
  })

  it('accepts the matching token and rejects a wrong/empty one', () => {
    const t = csrfToken(SECRET, SID)
    expect(verifyCsrfToken(SECRET, SID, t)).toBe(true)
    expect(verifyCsrfToken(SECRET, SID, 'not-the-token')).toBe(false)
    expect(verifyCsrfToken(SECRET, SID, '')).toBe(false)
    expect(verifyCsrfToken(SECRET, SID, null)).toBe(false)
  })

  it('rejects a token minted for a DIFFERENT session (tampered/injected session id)', () => {
    // Attacker presents a valid-looking token for their own session but the
    // request rides the victim's session id -> the recomputed HMAC differs.
    const attackerToken = csrfToken(SECRET, 'attacker-session')
    expect(verifyCsrfToken(SECRET, 'victim-session', attackerToken)).toBe(false)
  })

  it('rejects when the server secret differs (forged cookie cannot be signed)', () => {
    const forged = csrfToken('some-other-secret', SID)
    expect(verifyCsrfToken(SECRET, SID, forged)).toBe(false)
  })
})

describe('Sec-Fetch-Site gate', () => {
  it('flags only an explicit cross-site request', () => {
    expect(isCrossSiteRequest('cross-site')).toBe(true)
    expect(isCrossSiteRequest('same-origin')).toBe(false)
    expect(isCrossSiteRequest('same-site')).toBe(false)
    expect(isCrossSiteRequest('none')).toBe(false)
    expect(isCrossSiteRequest(null)).toBe(false) // absent -> not rejected on its own
  })
})

describe('guardUnsafeRequest', () => {
  const token = csrfToken(SECRET, SID)

  it('passes safe methods untouched', () => {
    expect(
      guardUnsafeRequest({
        method: 'GET',
        secFetchSite: 'cross-site',
        sessionId: SID,
        presentedToken: null,
        secret: SECRET,
      })
    ).toEqual({ ok: true })
  })

  it('rejects a cross-site unsafe request BEFORE the CSRF check', () => {
    expect(
      guardUnsafeRequest({
        method: 'POST',
        secFetchSite: 'cross-site',
        sessionId: SID,
        presentedToken: token, // even a valid token loses to the Fetch-Metadata gate
        secret: SECRET,
      })
    ).toEqual({ ok: false, reason: 'cross_site' })
  })

  it('accepts a same-origin unsafe request with a valid token', () => {
    expect(
      guardUnsafeRequest({
        method: 'POST',
        secFetchSite: 'same-origin',
        sessionId: SID,
        presentedToken: token,
        secret: SECRET,
      })
    ).toEqual({ ok: true })
  })

  it('rejects a same-origin unsafe request with a missing/invalid token', () => {
    expect(
      guardUnsafeRequest({
        method: 'DELETE',
        secFetchSite: 'same-origin',
        sessionId: SID,
        presentedToken: 'bogus',
        secret: SECRET,
      })
    ).toEqual({ ok: false, reason: 'csrf' })
  })
})

describe('csrf cookie', () => {
  it('is readable (no HttpOnly) but Secure + SameSite=Strict', () => {
    const cookie = serializeCsrfCookie('tok')
    expect(cookie).toBe('csrf=tok; Path=/; Secure; SameSite=Strict')
    expect(cookie).not.toMatch(/HttpOnly/)
  })

  it('clears with Max-Age=0', () => {
    expect(clearCsrfCookie()).toBe('csrf=; Path=/; Secure; SameSite=Strict; Max-Age=0')
  })
})
