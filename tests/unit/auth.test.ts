import { describe, expect, it } from 'vitest'
import { DEV_USER, getCurrentUser, login, logout } from '../../src/lib/api/auth'

// These run with the default VITE_AUTH_MODE (disabled).
describe('auth stubs (disabled mode)', () => {
  it('getCurrentUser resolves the static dev user', async () => {
    await expect(getCurrentUser()).resolves.toEqual(DEV_USER)
  })

  it('login is a documented no-op (does not throw, does not navigate)', () => {
    const before = location.href
    expect(() => login('/somewhere')).not.toThrow()
    expect(location.href).toBe(before)
  })

  it('logout is a documented no-op that resolves false (no navigation)', async () => {
    // In disabled mode logout does nothing and reports it did not navigate away.
    await expect(logout()).resolves.toBe(false)
  })
})
