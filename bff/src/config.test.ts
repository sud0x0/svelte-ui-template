import { describe, expect, it } from 'vitest'
import { loadConfig, ConfigError } from './config.ts'

// A minimal valid environment; individual tests clone and mutate it.
const BASE = {
  BFF_PUBLIC_ORIGIN: 'http://localhost:8081',
  BFF_ISSUER_URL: 'https://idp.example.com',
  BFF_CLIENT_ID: 'spa-bff',
  BFF_CLIENT_SECRET: 'super-secret',
  BFF_API_UPSTREAM: 'http://localhost:8080',
  BFF_COOKIE_SECRET: 'x'.repeat(32),
} satisfies NodeJS.ProcessEnv

describe('BFF config', () => {
  it('loads a valid environment and derives redirect_uri from the origin', () => {
    const cfg = loadConfig(BASE)
    expect(cfg.port).toBe(8081)
    expect(cfg.redirectUri).toBe('http://localhost:8081/auth/callback')
    expect(cfg.scopes).toBe('openid profile email')
  })

  it('strips a trailing slash from absolute URLs so path concatenation is predictable', () => {
    const cfg = loadConfig({ ...BASE, BFF_PUBLIC_ORIGIN: 'http://localhost:8081/' })
    expect(cfg.redirectUri).toBe('http://localhost:8081/auth/callback')
  })

  it.each([
    'BFF_PUBLIC_ORIGIN',
    'BFF_ISSUER_URL',
    'BFF_CLIENT_ID',
    'BFF_CLIENT_SECRET',
    'BFF_API_UPSTREAM',
    'BFF_COOKIE_SECRET',
  ])('fails fast when %s is missing', (key) => {
    const env = { ...BASE }
    delete (env as Record<string, string | undefined>)[key]
    expect(() => loadConfig(env)).toThrow(ConfigError)
    expect(() => loadConfig(env)).toThrow(key)
  })

  it('rejects a non-absolute issuer URL', () => {
    expect(() => loadConfig({ ...BASE, BFF_ISSUER_URL: 'idp.example.com' })).toThrow(ConfigError)
  })

  it('rejects a cookie secret under 32 BYTES (not chars) — multibyte-aware', () => {
    expect(() => loadConfig({ ...BASE, BFF_COOKIE_SECRET: 'short' })).toThrow(/32 bytes/)
    expect(() => loadConfig({ ...BASE, BFF_COOKIE_SECRET: 'a'.repeat(31) })).toThrow(/32 bytes/)
    expect(loadConfig({ ...BASE, BFF_COOKIE_SECRET: 'a'.repeat(32) }).cookieSecret).toHaveLength(32)

    // Multibyte tripwire: 'é' (U+00E9) is 1 CHAR but 2 UTF-8 BYTES. A byte→char
    // regression (using .length) would wrongly accept a 31-byte secret and reject
    // a valid 32-byte one, so cover both sides explicitly.
    const e = 'é' // é (U+00E9), 1 char / 2 bytes in UTF-8
    // 16 chars = 32 bytes -> accepted (and stored as the 16-char string).
    expect(loadConfig({ ...BASE, BFF_COOKIE_SECRET: e.repeat(16) }).cookieSecret).toHaveLength(16)
    // 15×2 + 1 = 31 bytes -> rejected, even though it is 16 chars long.
    expect(() => loadConfig({ ...BASE, BFF_COOKIE_SECRET: e.repeat(15) + 'x' })).toThrow(/32 bytes/)
  })

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig({ ...BASE, BFF_PORT: '0' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...BASE, BFF_PORT: 'not-a-port' })).toThrow(ConfigError)
  })

  it('defaults the upstream timeout to 10000ms and accepts a valid override', () => {
    expect(loadConfig(BASE).apiTimeoutMs).toBe(10_000)
    expect(loadConfig({ ...BASE, BFF_API_TIMEOUT_MS: '2500' }).apiTimeoutMs).toBe(2500)
  })

  it('rejects an out-of-range or non-integer upstream timeout', () => {
    // Bounds are (0, 60000] ms, integer only.
    expect(() => loadConfig({ ...BASE, BFF_API_TIMEOUT_MS: '0' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...BASE, BFF_API_TIMEOUT_MS: '60001' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...BASE, BFF_API_TIMEOUT_MS: '1.5' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...BASE, BFF_API_TIMEOUT_MS: 'nope' })).toThrow(ConfigError)
  })

  it('leaves audience undefined when BFF_AUDIENCE is unset or blank, passes it through when set', () => {
    expect(loadConfig(BASE).audience).toBeUndefined()
    expect(loadConfig({ ...BASE, BFF_AUDIENCE: '   ' }).audience).toBeUndefined()
    expect(loadConfig({ ...BASE, BFF_AUDIENCE: 'https://go-api.example.com' }).audience).toBe(
      'https://go-api.example.com'
    )
  })

  // Item 3: an http:// issuer/upstream is a silent TLS downgrade unless it is
  // loopback or explicitly opted in via BFF_DEV_INSECURE.
  it('rejects a NON-loopback http:// issuer or upstream without BFF_DEV_INSECURE', () => {
    expect(() => loadConfig({ ...BASE, BFF_ISSUER_URL: 'http://idp.example.com' })).toThrow(/https/)
    expect(() => loadConfig({ ...BASE, BFF_API_UPSTREAM: 'http://api.example.com' })).toThrow(
      ConfigError
    )
  })

  it('still boots for loopback http (localhost / 127.0.0.1 / ::1 / *.localhost)', () => {
    // The default BASE already uses http://localhost for the upstream.
    expect(() => loadConfig(BASE)).not.toThrow()
    for (const host of ['localhost:9', '127.0.0.1:9', '[::1]:9', 'sub.localhost:9']) {
      expect(() =>
        loadConfig({
          ...BASE,
          BFF_ISSUER_URL: `http://${host}`,
          BFF_API_UPSTREAM: `http://${host}`,
        })
      ).not.toThrow()
    }
  })

  it('permits a non-loopback http endpoint only with the explicit BFF_DEV_INSECURE=true opt-in', () => {
    const insecure = { ...BASE, BFF_ISSUER_URL: 'http://idp.example.com', BFF_DEV_INSECURE: 'true' }
    expect(() => loadConfig(insecure)).not.toThrow()
    expect(loadConfig(insecure).issuerUrl).toBe('http://idp.example.com')
    // Any value other than the exact string 'true' does NOT opt in.
    expect(() => loadConfig({ ...insecure, BFF_DEV_INSECURE: '1' })).toThrow(/https/)
  })
})
