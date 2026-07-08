import * as client from 'openid-client'
import type { BffConfig } from './config.ts'
import type { StoredTokens } from './session.ts'

// The confidential OIDC client. Wraps openid-client v6 so routes/auth.ts and
// proxy.ts speak in domain terms (begin/complete login, refresh, end-session)
// and never touch the OAuth library directly.
//
// Confidential client + Authorization Code grant is MANDATED for a BFF by
// draft-ietf-oauth-browser-based-apps §6.1.3.1 (via RFC 9700 §2.1.1). The client
// authenticates to the token endpoint with its secret (ClientSecretPost), which
// the browser never sees.

/** The claims we read off the validated ID token. Loose by design — IdPs vary. */
export type Claims = Record<string, unknown>

export interface BeginLoginResult {
  /** Absolute authorization endpoint URL to 302 the browser to. */
  authorizationUrl: string
  /** The per-login secrets to stash server-side (never sent to the browser). */
  transaction: { state: string; nonce: string; codeVerifier: string }
}

export interface OidcClient {
  beginLogin(): Promise<BeginLoginResult>
  completeLogin(
    currentUrl: string,
    txn: { state: string; nonce: string; codeVerifier: string }
  ): Promise<{ tokens: StoredTokens; claims: Claims }>
  refresh(previous: StoredTokens): Promise<StoredTokens>
  hasEndSession(): boolean
  endSessionUrl(idToken: string): string
}

export interface CreateOidcOptions {
  /** Allow http:// IdP endpoints (localhost dev / tests). Never set in production. */
  allowInsecure?: boolean
}

/**
 * Access-token lifetime (seconds) to assume when the IdP omits `expires_in`.
 * Conservative on purpose (item 8): mapping a missing `expires_in` to 0 would set
 * the expiry to "now", so the very next request treats the token as expired and
 * forces an immediate refresh — or, if no refresh token was issued, a 401 loop
 * right after login. 300s gives the token a sane usable window.
 */
export const DEFAULT_ACCESS_TOKEN_LIFETIME_S = 300

/** Absolute access-token expiry (epoch ms) from an optional `expires_in`. */
export function accessTokenExpiryMs(expiresInSeconds: number | undefined, nowMs: number): number {
  return nowMs + (expiresInSeconds ?? DEFAULT_ACCESS_TOKEN_LIFETIME_S) * 1000
}

function toStoredTokens(
  tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers,
  fallback: Partial<StoredTokens> = {}
): StoredTokens {
  return {
    accessToken: tokens.access_token,
    // Rotation (RFC 9700 §4.14): prefer a freshly issued refresh token; keep the
    // previous one only if the AS did not rotate.
    refreshToken: tokens.refresh_token ?? fallback.refreshToken,
    // A refresh response often omits the id_token — keep the prior one so logout
    // still has an id_token_hint.
    idToken: tokens.id_token ?? fallback.idToken,
    accessTokenExpiresAt: accessTokenExpiryMs(tokens.expiresIn(), Date.now()),
  }
}

/**
 * Discovers the IdP ONCE at startup and returns the client. Fails fast on a
 * discovery error (mirrors the Go template's "never boot half-configured"
 * stance) — the caller lets the rejection crash startup.
 */
export async function createOidc(
  config: BffConfig,
  options: CreateOidcOptions = {}
): Promise<OidcClient> {
  const configuration = await client.discovery(
    new URL(config.issuerUrl),
    config.clientId,
    undefined,
    // Confidential client: authenticate to the token endpoint with the secret in
    // the POST body (client_secret_post). Server-side only.
    client.ClientSecretPost(config.clientSecret),
    options.allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined
  )

  // When an audience is configured, send it as the `audience` request parameter
  // on BOTH the authorization request and every token/refresh grant, so the IdP
  // mints an access token whose `aud` the Go API accepts (item 3). Undefined when
  // unset, so openid-client sends nothing extra.
  const audienceParam: Record<string, string> | undefined =
    config.audience !== undefined ? { audience: config.audience } : undefined

  return {
    async beginLogin() {
      // PKCE (RFC 7636) is used EVEN THOUGH this is a confidential client:
      // RFC 9700 §2.1.1 recommends PKCE for every client, not just public ones.
      const codeVerifier = client.randomPKCECodeVerifier()
      const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier)
      const state = client.randomState()
      const nonce = client.randomNonce()
      const authorizationUrl = client.buildAuthorizationUrl(configuration, {
        redirect_uri: config.redirectUri,
        scope: config.scopes,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        nonce,
        ...audienceParam,
      })
      return {
        authorizationUrl: authorizationUrl.href,
        transaction: { state, nonce, codeVerifier },
      }
    },

    async completeLogin(currentUrl, txn) {
      // openid-client validates `state` (against expectedState), the PKCE
      // verifier, the ID-token signature/iss/aud/exp, and `nonce` (against
      // expectedNonce) — throwing on any mismatch. `audienceParam` (when set) is
      // sent as an extra token-endpoint parameter.
      const tokens = await client.authorizationCodeGrant(
        configuration,
        new URL(currentUrl),
        {
          pkceCodeVerifier: txn.codeVerifier,
          expectedState: txn.state,
          expectedNonce: txn.nonce,
        },
        audienceParam
      )
      const claims = tokens.claims()
      if (claims === undefined) {
        throw new Error('authorization server returned no id_token')
      }
      return { tokens: toStoredTokens(tokens), claims }
    },

    async refresh(previous) {
      if (previous.refreshToken === undefined) {
        throw new Error('no refresh token available')
      }
      const tokens = await client.refreshTokenGrant(
        configuration,
        previous.refreshToken,
        audienceParam
      )
      return toStoredTokens(tokens, previous)
    },

    hasEndSession() {
      return configuration.serverMetadata().end_session_endpoint !== undefined
    },

    endSessionUrl(idToken) {
      // RP-initiated logout with id_token_hint + post_logout_redirect_uri=<origin>/.
      return client.buildEndSessionUrl(configuration, {
        id_token_hint: idToken,
        post_logout_redirect_uri: `${config.publicOrigin}/`,
      }).href
    },
  }
}
