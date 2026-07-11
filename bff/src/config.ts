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
  /** Timeout in ms for a proxied upstream (Go API) call, so a hung upstream cannot pin a BFF connection. */
  apiTimeoutMs: number
  /** Timeout in ms for the BFF's OWN openid-client calls to the IdP (discovery/token/refresh) (fix 9). */
  oidcTimeoutMs: number
  /**
   * When true, the BFF runs behind a TRUSTED reverse proxy (e.g. Caddy) and
   * PRESERVES the inbound `X-Forwarded-For` (appending its own peer) so the Go API
   * sees the real client IP. When false (default, directly-exposed BFF) it strips
   * the inbound XFF and sets it to its immediate un-spoofable peer (fix 11).
   */
  trustedProxy: boolean
  /** HMAC key for the signed double-submit CSRF token (security.md rule 2). ≥32 bytes. */
  cookieSecret: string
  /** Space-delimited OIDC scopes. */
  scopes: string
  /**
   * Optional access-token audience. When set, it is sent as the `audience`
   * request parameter on the authorization request and the token + refresh
   * grants, so the IdP mints an access token whose `aud` the Go API accepts
   * (it 401s any bearer whose `aud` != its OIDC_AUDIENCE). MUST equal the Go
   * API's OIDC_AUDIENCE. Leave unset if the IdP sets the access-token audience
   * server-side instead. Undefined when `BFF_AUDIENCE` is absent/empty.
   */
  audience?: string
  /**
   * Server-side session + login-transaction store backend (decisions #21):
   * - 'memory' (default): the in-process reference stores (session.ts). Single
   *   instance, non-durable — sessions evaporate on restart (decisions #18).
   * - 'valkey': a shared Valkey (RESP) store so sessions survive restarts and are
   *   shared across BFF replicas. BOTH the session and login-transaction state move.
   */
  sessionStore: 'memory' | 'valkey'
  /**
   * Valkey connection URL (`redis://` / `rediss://`). Present ONLY when
   * `sessionStore === 'valkey'`, validated like the issuer/upstream: TLS
   * (`rediss://`) is required for a non-loopback host unless BFF_DEV_INSECURE — a
   * production Valkey URL carries session tokens, so plaintext off-loopback fails fast.
   */
  valkeyUrl?: string
  /** Key namespace for Valkey keys (default `bff:`). Lets one Valkey serve many apps. */
  valkeyKeyPrefix: string
  /** Connect + per-command timeout (ms) for the Valkey client. Integer in (0, 60000]. */
  valkeyConnectTimeoutMs: number
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

/** True for loopback hosts where plain `http` is acceptable for local dev / E2E. */
function isLoopbackHost(hostname: string): boolean {
  // URL lowercases hostnames; the IPv6 loopback arrives bracketed as '[::1]'.
  const host = hostname.replace(/^\[|\]$/g, '')
  return (
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  )
}

/**
 * Like {@link requireAbsoluteUrl}, but REJECTS a plain-`http://` URL unless the
 * host is loopback OR `BFF_DEV_INSECURE=true` is set (item 3). The issuer
 * (discovery / token / refresh) and the upstream both carry the client secret
 * and tokens, so a mis-set production `http://` endpoint would silently disable
 * openid-client's HTTPS enforcement. Fail fast at load rather than downgrade TLS
 * transparently. The E2E stub uses `http://localhost`, so loopback stays allowed.
 */
function requireSecureBackendUrl(
  env: NodeJS.ProcessEnv,
  key: string,
  devInsecure: boolean
): string {
  const raw = requireAbsoluteUrl(env, key)
  const url = new URL(raw)
  if (url.protocol === 'http:' && !devInsecure && !isLoopbackHost(url.hostname)) {
    throw new ConfigError(
      `${key} must use https:// (got ${raw}). Plain http is allowed only for a ` +
        `loopback host; for a non-loopback http endpoint set BFF_DEV_INSECURE=true (DEV ONLY).`
    )
  }
  return raw
}

/**
 * Validates a Valkey connection URL with the SAME transport stance as
 * {@link requireSecureBackendUrl}: TLS is mandatory off-loopback because the URL
 * carries session tokens. Accepts `redis://`/`valkey://` (plaintext) and
 * `rediss://`/`valkeys://` (TLS); a non-loopback plaintext URL is rejected unless
 * BFF_DEV_INSECURE. The `valkey(s)://` alias is normalised to `redis(s)://` so the
 * RESP client (which speaks redis-scheme URLs and infers TLS from `rediss://`)
 * accepts it unchanged.
 */
function requireValkeyUrl(env: NodeJS.ProcessEnv, key: string, devInsecure: boolean): string {
  const raw = requireEnv(env, key)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError(`${key} must be a valid URL (got: ${raw})`)
  }
  const tls = url.protocol === 'rediss:' || url.protocol === 'valkeys:'
  const plain = url.protocol === 'redis:' || url.protocol === 'valkey:'
  if (!tls && !plain) {
    throw new ConfigError(
      `${key} must be a redis://, rediss://, valkey:// or valkeys:// URL (got: ${raw})`
    )
  }
  if (plain && !devInsecure && !isLoopbackHost(url.hostname)) {
    throw new ConfigError(
      `${key} must use rediss:// (TLS) for a non-loopback host; plain redis:// is ` +
        `allowed only for a loopback host, or set BFF_DEV_INSECURE=true (DEV ONLY). Got ${raw}.`
    )
  }
  // Normalise the valkey(s):// alias to the redis(s):// scheme the RESP client speaks.
  if (url.protocol === 'valkey:') url.protocol = 'redis:'
  else if (url.protocol === 'valkeys:') url.protocol = 'rediss:'
  return url.toString()
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

  // Bound the proxied upstream call so a hung Go API cannot pin a BFF connection
  // until the OS socket timeout. Integer ms in (0, 60000].
  const apiTimeoutRaw = env.BFF_API_TIMEOUT_MS ?? '10000'
  const apiTimeoutMs = Number(apiTimeoutRaw)
  if (!Number.isInteger(apiTimeoutMs) || apiTimeoutMs <= 0 || apiTimeoutMs > 60000) {
    throw new ConfigError(
      `BFF_API_TIMEOUT_MS must be an integer in (0, 60000] ms (got: ${apiTimeoutRaw})`
    )
  }

  // Bound the BFF's OWN calls to the IdP (discovery/token/refresh) so a hung IdP
  // cannot pin /auth/callback or stall the refresh queue (fix 9). Integer ms in
  // (0, 60000].
  const oidcTimeoutRaw = env.BFF_OIDC_TIMEOUT_MS ?? '10000'
  const oidcTimeoutMs = Number(oidcTimeoutRaw)
  if (!Number.isInteger(oidcTimeoutMs) || oidcTimeoutMs <= 0 || oidcTimeoutMs > 60000) {
    throw new ConfigError(
      `BFF_OIDC_TIMEOUT_MS must be an integer in (0, 60000] ms (got: ${oidcTimeoutRaw})`
    )
  }

  // Optional: only include when non-empty so `audience` is genuinely undefined
  // (not an empty string) when unset, and the OIDC layer can branch on presence.
  const audience = env.BFF_AUDIENCE?.trim()

  // Opt-in to plain http for NON-loopback issuer/upstream (dev only). Loopback
  // http is always allowed; anything else over http fails fast (item 3).
  const devInsecure = env.BFF_DEV_INSECURE === 'true'

  // Trust the immediate reverse proxy's X-Forwarded-For (fix 11). Off by default:
  // only enable when the BFF genuinely sits behind a trusted proxy (e.g. Caddy).
  const trustedProxy = env.BFF_TRUSTED_PROXY === 'true'

  // Session/txn store backend (decisions #21). Explicit switch, default 'memory'
  // so a fresh clone is unchanged. Only when 'valkey' is BFF_VALKEY_URL required.
  const sessionStore = env.BFF_SESSION_STORE ?? 'memory'
  if (sessionStore !== 'memory' && sessionStore !== 'valkey') {
    throw new ConfigError(`BFF_SESSION_STORE must be 'memory' or 'valkey' (got: ${sessionStore})`)
  }
  const valkeyUrl =
    sessionStore === 'valkey' ? requireValkeyUrl(env, 'BFF_VALKEY_URL', devInsecure) : undefined
  const valkeyKeyPrefix = env.BFF_VALKEY_KEY_PREFIX ?? 'bff:'

  // Bound the Valkey connect + per-command time so a hung/unreachable Valkey
  // cannot pin an /auth or /api request. Integer ms in (0, 60000].
  const valkeyTimeoutRaw = env.BFF_VALKEY_CONNECT_TIMEOUT_MS ?? '10000'
  const valkeyConnectTimeoutMs = Number(valkeyTimeoutRaw)
  if (
    !Number.isInteger(valkeyConnectTimeoutMs) ||
    valkeyConnectTimeoutMs <= 0 ||
    valkeyConnectTimeoutMs > 60000
  ) {
    throw new ConfigError(
      `BFF_VALKEY_CONNECT_TIMEOUT_MS must be an integer in (0, 60000] ms (got: ${valkeyTimeoutRaw})`
    )
  }

  return {
    port,
    publicOrigin,
    // redirect_uri is DERIVED, not configured, so it can never drift from the
    // origin the cookies are scoped to. The IdP must register exactly this value.
    redirectUri: `${publicOrigin}/auth/callback`,
    issuerUrl: requireSecureBackendUrl(env, 'BFF_ISSUER_URL', devInsecure),
    clientId: requireEnv(env, 'BFF_CLIENT_ID'),
    clientSecret: requireEnv(env, 'BFF_CLIENT_SECRET'),
    apiUpstream: requireSecureBackendUrl(env, 'BFF_API_UPSTREAM', devInsecure),
    apiTimeoutMs,
    oidcTimeoutMs,
    trustedProxy,
    cookieSecret,
    scopes: env.BFF_SCOPES ?? 'openid profile email',
    ...(audience ? { audience } : {}),
    sessionStore,
    ...(valkeyUrl ? { valkeyUrl } : {}),
    valkeyKeyPrefix,
    valkeyConnectTimeoutMs,
  }
}
