// The BFF's single source of build/runtime configuration.
//
// Mirrors the SPA's config seam (src/lib/config.ts) and the Go template's
// "never boot half-configured" stance: this is the ONE place that reads
// `process.env`, every value is validated at load, and a missing/invalid value
// throws a named ConfigError so the process fails fast at startup rather than
// mis-behaving under load. Nothing here is a secret that reaches the browser —
// the client secret and cookie secret live only in this server process.

/** Thrown when the environment is missing or malformed. Named so callers (and
 *  tests) can assert on the failure mode rather than a bare Error. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export interface BffConfig {
  /** TCP port the BFF listens on. */
  port: number
  /** Absolute public origin the browser reaches the BFF on (scheme + host [+ port]). */
  publicOrigin: string
  /** OIDC redirect_uri, derived as `<publicOrigin>/auth/callback` — never configured directly. */
  redirectUri: string
  /** OIDC issuer URL for discovery (`<issuer>/.well-known/openid-configuration`). */
  issuerUrl: string
  /** OAuth client_id registered at the IdP. */
  clientId: string
  /** OAuth client_secret. Confidential client per BCP 6.1.3.1 — kept server-side only. */
  clientSecret: string
  /** Base URL of the Go API this BFF proxies `/api/*` to. */
  apiUpstream: string
  /** HMAC key for the signed double-submit CSRF token (security.md rule 2). ≥32 bytes. */
  cookieSecret: string
  /** Space-delimited OIDC scopes. */
  scopes: string
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(`${key} is required`)
  }
  return value
}

function requireAbsoluteUrl(env: NodeJS.ProcessEnv, key: string): string {
  const raw = requireEnv(env, key)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError(`${key} must be an absolute URL (got: ${raw})`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${key} must be an http(s) URL (got: ${raw})`)
  }
  // Normalise away a trailing slash so callers can concatenate paths predictably.
  return raw.replace(/\/+$/, '')
}

/**
 * Reads and validates the environment — the ONE `process.env` read site. Called
 * exactly once, by server.ts (the composition root). Every other module takes
 * its config as a parameter, so unit tests drive them with an explicit
 * {@link BffConfig} and never touch the real environment. Exported (not run
 * eagerly) so importing this module has no side effects.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BffConfig {
  const publicOrigin = requireAbsoluteUrl(env, 'BFF_PUBLIC_ORIGIN')

  // ≥32 bytes: an HMAC-SHA256 key shorter than the hash output weakens the CSRF
  // token (security.md rule 2). Measure BYTES, not characters — a short
  // multibyte string can look "long enough" by `.length` yet be under 32 bytes.
  const cookieSecret = requireEnv(env, 'BFF_COOKIE_SECRET')
  if (Buffer.byteLength(cookieSecret, 'utf8') < 32) {
    throw new ConfigError('BFF_COOKIE_SECRET must be at least 32 bytes')
  }

  const portRaw = env.BFF_PORT ?? '8081'
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`BFF_PORT must be a valid port number (got: ${portRaw})`)
  }

  return {
    port,
    publicOrigin,
    // redirect_uri is DERIVED, not configured, so it can never drift from the
    // origin the cookies are scoped to. The IdP must register exactly this value.
    redirectUri: `${publicOrigin}/auth/callback`,
    issuerUrl: requireAbsoluteUrl(env, 'BFF_ISSUER_URL'),
    clientId: requireEnv(env, 'BFF_CLIENT_ID'),
    clientSecret: requireEnv(env, 'BFF_CLIENT_SECRET'),
    apiUpstream: requireAbsoluteUrl(env, 'BFF_API_UPSTREAM'),
    cookieSecret,
    scopes: env.BFF_SCOPES ?? 'openid profile email',
  }
}
