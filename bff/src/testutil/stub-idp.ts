import { createServer, type Server } from 'node:http'
import { createHash, generateKeyPairSync, sign, randomBytes, type KeyObject } from 'node:crypto'

// A REAL local OIDC provider for the BFF unit tests: a node:http listener that
// serves discovery, JWKS, authorize, token, and end_session, and mints RS256
// ID tokens signed with a runtime-generated key (node:crypto only — no jose
// import, no committed secrets). Nothing here is production code; it lives under
// bff/src/testutil and is imported only by *.test.ts.

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

/**
 * Validates an OAuth redirect target the way a real IdP validates a REGISTERED
 * redirect_uri: it must be an absolute http(s) URL on a loopback host (every test
 * client runs on loopback). Returns a parsed URL when allowed, else null — so the
 * caller never writes an unvalidated, attacker-controlled query value into a
 * Location header (the js/server-side-unvalidated-url-redirection sink). Mirrors
 * config.ts's loopback check.
 */
function validatedRedirect(raw: string | null): URL | null {
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const loopback =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  return loopback ? u : null
}

/** Minimal RS256 JWT signer (~15 lines) — enough for ID tokens in tests. */
function signJwt(payload: Record<string, unknown>, privateKey: KeyObject, kid: string): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))
  const body = base64url(JSON.stringify(payload))
  const data = `${header}.${body}`
  const signature = sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')
  return `${data}.${signature}`
}

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export interface StubIdp {
  issuer: string
  clientId: string
  clientSecret: string
  /** Claims baked into the next ID token. Mutate between tests. */
  claims: Record<string, unknown>
  /** When true, the ID token carries a wrong nonce (to test nonce validation). */
  tamperNonce: boolean
  /** Number of successful token-endpoint exchanges (login + refresh). */
  tokenHits: number
  /** Query params of the most recent /authorize request (lets tests assert e.g. `audience`). */
  lastAuthorizeQuery: URLSearchParams | null
  /** Body params of the most recent /token request (lets tests assert e.g. `audience`). */
  lastTokenBody: URLSearchParams | null
  close(): Promise<void>
}

interface PendingCode {
  codeChallenge: string
  nonce: string
  clientId: string
}

export async function startStubIdp(): Promise<StubIdp> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const kid = 'test-key-1'
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }
  const codes = new Map<string, PendingCode>()

  const state: StubIdp = {
    issuer: '',
    clientId: 'spa-bff',
    clientSecret: randomBytes(24).toString('hex'),
    claims: {
      sub: 'user-123',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      roles: ['user'],
      groups: ['beta'],
    },
    tamperNonce: false,
    tokenHits: 0,
    lastAuthorizeQuery: null,
    lastTokenBody: null,
    close: async () => {},
  }

  function mintIdToken(nonce: string): string {
    const nowSec = Math.floor(Date.now() / 1000)
    return signJwt(
      {
        iss: state.issuer,
        aud: state.clientId,
        iat: nowSec,
        exp: nowSec + 3600,
        nonce: state.tamperNonce ? 'wrong-nonce' : nonce,
        ...state.claims,
      },
      privateKey,
      kid
    )
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', state.issuer)
      const path = url.pathname

      if (path === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(
          JSON.stringify({
            issuer: state.issuer,
            authorization_endpoint: `${state.issuer}/authorize`,
            token_endpoint: `${state.issuer}/token`,
            jwks_uri: `${state.issuer}/jwks`,
            end_session_endpoint: `${state.issuer}/end-session`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            token_endpoint_auth_methods_supported: ['client_secret_post'],
            code_challenge_methods_supported: ['S256'],
            scopes_supported: ['openid', 'profile', 'email'],
          })
        )
      }

      if (path === '/jwks') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ keys: [jwk] }))
      }

      if (path === '/authorize') {
        state.lastAuthorizeQuery = url.searchParams
        // A real IdP only ever redirects to a REGISTERED redirect_uri. Validate it
        // before writing it into a Location header, else it is an open redirect; on
        // failure reject like a real IdP would (never redirect to an unknown URI).
        const target = validatedRedirect(url.searchParams.get('redirect_uri'))
        if (!target) {
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          return res.end('invalid redirect_uri')
        }
        // Record the challenge + nonce keyed by a fresh code, then 302 back. The
        // Location is built from the VALIDATED URL object, not the raw query value.
        const code = randomBytes(16).toString('hex')
        codes.set(code, {
          codeChallenge: url.searchParams.get('code_challenge') ?? '',
          nonce: url.searchParams.get('nonce') ?? '',
          clientId: url.searchParams.get('client_id') ?? '',
        })
        target.searchParams.set('code', code)
        target.searchParams.set('state', url.searchParams.get('state') ?? '')
        res.writeHead(302, { Location: target.href })
        return res.end()
      }

      if (path === '/token' && req.method === 'POST') {
        const params = new URLSearchParams(await readBody(req))
        state.lastTokenBody = params
        const grantType = params.get('grant_type')

        // Confidential-client auth: client_secret_post. A wrong secret is
        // invalid_client (proves the exchange is authenticated).
        if (
          params.get('client_id') !== state.clientId ||
          params.get('client_secret') !== state.clientSecret
        ) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'invalid_client' }))
        }

        let nonce = ''
        if (grantType === 'authorization_code') {
          const code = params.get('code') ?? ''
          const pending = codes.get(code)
          codes.delete(code)
          const verifier = params.get('code_verifier') ?? ''
          const challenge = base64url(createHash('sha256').update(verifier).digest())
          if (!pending || pending.codeChallenge !== challenge) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ error: 'invalid_grant' }))
          }
          nonce = pending.nonce
        } else if (grantType === 'refresh_token') {
          if (!params.get('refresh_token')) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ error: 'invalid_grant' }))
          }
          // No nonce on refresh; id_token may be reissued without one.
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'unsupported_grant_type' }))
        }

        state.tokenHits += 1
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(
          JSON.stringify({
            access_token: `at-${randomBytes(8).toString('hex')}`,
            refresh_token: `rt-${randomBytes(8).toString('hex')}`, // rotated each call
            id_token: mintIdToken(nonce),
            token_type: 'Bearer',
            expires_in: 3600,
          })
        )
      }

      if (path === '/end-session') {
        // Validate the post-logout redirect the same way (open-redirect guard);
        // fall back to the issuer root when absent or not an allowed target.
        const raw = url.searchParams.get('post_logout_redirect_uri')
        const target = raw ? validatedRedirect(raw) : null
        res.writeHead(302, { Location: target ? target.href : '/' })
        return res.end()
      }

      res.writeHead(404)
      res.end()
    })()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('stub idp failed to bind')
  state.issuer = `http://127.0.0.1:${address.port}`
  state.close = () =>
    new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  return state
}
