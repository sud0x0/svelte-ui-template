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

  it('rejects a cookie secret under 32 bytes (measured in bytes, not chars)', () => {
    // 16 two-byte characters = 32 bytes exactly is OK; one fewer is not.
    expect(() => loadConfig({ ...BASE, BFF_COOKIE_SECRET: 'short' })).toThrow(/32 bytes/)
    expect(() => loadConfig({ ...BASE, BFF_COOKIE_SECRET: 'a'.repeat(31) })).toThrow(/32 bytes/)
    expect(loadConfig({ ...BASE, BFF_COOKIE_SECRET: 'a'.repeat(32) }).cookieSecret).toHaveLength(32)
  })

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig({ ...BASE, BFF_PORT: '0' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...BASE, BFF_PORT: 'not-a-port' })).toThrow(ConfigError)
  })
})
