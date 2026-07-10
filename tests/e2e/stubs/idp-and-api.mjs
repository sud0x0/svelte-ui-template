// A test-only stub that plays BOTH the OIDC IdP and the upstream Go API, on one
// port. Started as a real process by Playwright's webServer (page.route cannot
// intercept the BFF's SERVER-side calls, so these must be real listeners).
//
// It proves two things a green run depends on:
//   1. The token endpoint verifies the PKCE verifier AND the client secret — a
//      wrong secret returns invalid_client, so a successful login proves the BFF
//      authenticated as a CONFIDENTIAL client.
//   2. /api/v1/logs returns data ONLY when the presented bearer equals the token
//      this stub minted — so a rendered logs list proves the proxy attached the
//      server-side access token.
//
// RS256 tokens are signed with a runtime-generated key (node:crypto only — no
// jose import, no committed secrets).
import { createServer } from 'node:http'
import { createHash, generateKeyPairSync, sign, randomBytes } from 'node:crypto'

const PORT = Number(process.env.STUB_PORT ?? 4199)
const ISSUER = `http://localhost:${PORT}`
const CLIENT_ID = process.env.BFF_CLIENT_ID ?? 'svelte-ui-bff'
const CLIENT_SECRET = process.env.BFF_CLIENT_SECRET ?? 'e2e-confidential-secret'

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KID = 'e2e-key-1'
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' }

const CLAIMS = {
  sub: 'ada-123',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  roles: ['user'],
  groups: ['beta'],
}

const codes = new Map() // code -> { codeChallenge, nonce }
let lastAccessToken = null // the token most recently minted; the API checks it
let logsStatus = 200 // flippable via /_control to exercise the 403 path
let logsPostCount = 0 // proves the BFF rejects an unsafe write before proxying
let lastForwarding = {} // forwarding headers the upstream saw (item 2 proof)

// Forwarding/trust headers the BFF MUST strip before proxying to this "Go API".
const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
]

const b64url = (input) => Buffer.from(input).toString('base64url')

function signJwt(payload) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }))
  const body = b64url(JSON.stringify(payload))
  const data = `${header}.${body}`
  const signature = sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')
  return `${data}.${signature}`
}

function mintTokens(nonce) {
  const nowSec = Math.floor(Date.now() / 1000)
  lastAccessToken = `at-${randomBytes(12).toString('hex')}`
  const idToken = signJwt({
    iss: ISSUER,
    aud: CLIENT_ID,
    iat: nowSec,
    exp: nowSec + 3600,
    ...(nonce ? { nonce } : {}),
    ...CLAIMS,
  })
  return {
    access_token: lastAccessToken,
    refresh_token: `rt-${randomBytes(12).toString('hex')}`,
    id_token: idToken,
    token_type: 'Bearer',
    expires_in: 3600,
  }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function json(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extra })
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url, ISSUER)
    const path = url.pathname

    // --- OIDC discovery + JWKS ---
    if (path === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        end_session_endpoint: `${ISSUER}/end-session`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'profile', 'email'],
      })
    }
    if (path === '/jwks') return json(res, 200, { keys: [JWK] })

    // --- Authorization endpoint: a real login PAGE, so "signed out" is
    //     observable after logout (no silent SSO auto-relogin). The link carries
    //     the original request params through to /authorize/consent. ---
    if (path === '/authorize') {
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Stub IdP</title></head>
<body><h1>Stub IdP login</h1>
<a id="stub-login" href="/authorize/consent${url.search}">Sign in as Ada</a>
</body></html>`
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(html)
    }
    if (path === '/authorize/consent') {
      const code = randomBytes(16).toString('hex')
      codes.set(code, {
        codeChallenge: url.searchParams.get('code_challenge') ?? '',
        nonce: url.searchParams.get('nonce') ?? '',
      })
      const redirectUri = url.searchParams.get('redirect_uri') ?? '/'
      const state = url.searchParams.get('state') ?? ''
      const location = `${redirectUri}?code=${code}&state=${encodeURIComponent(state)}`
      res.writeHead(302, { Location: location })
      return res.end()
    }

    // --- Token endpoint (confidential client: client_secret_post) ---
    if (path === '/token' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req))
      if (params.get('client_id') !== CLIENT_ID || params.get('client_secret') !== CLIENT_SECRET) {
        return json(res, 401, { error: 'invalid_client' })
      }
      const grant = params.get('grant_type')
      if (grant === 'authorization_code') {
        const pending = codes.get(params.get('code') ?? '')
        codes.delete(params.get('code') ?? '')
        const verifier = params.get('code_verifier') ?? ''
        const challenge = b64url(createHash('sha256').update(verifier).digest())
        if (!pending || pending.codeChallenge !== challenge) {
          return json(res, 400, { error: 'invalid_grant' })
        }
        return json(res, 200, mintTokens(pending.nonce))
      }
      if (grant === 'refresh_token') {
        if (!params.get('refresh_token')) return json(res, 400, { error: 'invalid_grant' })
        return json(res, 200, mintTokens(''))
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }

    if (path === '/end-session') {
      res.writeHead(302, { Location: url.searchParams.get('post_logout_redirect_uri') ?? '/' })
      return res.end()
    }

    // --- Stub upstream Go API ---
    if (path === '/health') return json(res, 200, { status: 'ok', version: 'e2e-stub' })

    if (path === '/api/v1/logs' && (req.method ?? 'GET') === 'GET') {
      // Record which forwarding/trust headers actually arrived (item 2 proof).
      lastForwarding = {}
      for (const h of FORWARDING_HEADERS) {
        if (req.headers[h] !== undefined) lastForwarding[h] = req.headers[h]
      }
      if (logsStatus === 403) {
        return json(res, 403, { error: 'forbidden', message: 'not authorised' })
      }
      // Return data ONLY for the exact bearer this stub minted — proving the BFF
      // attached the server-side access token.
      const auth = req.headers['authorization']
      if (auth !== `Bearer ${lastAccessToken}`) {
        return json(res, 401, { error: 'unauthorised', message: 'bad bearer' })
      }
      const entry = {
        id: 'log-e2e-1',
        user_id: 'ada-123',
        date_and_time: '2026-07-07T09:00:00Z',
        log: 'proxied log entry via BFF',
        created_at: '2026-07-07T09:00:00Z',
        updated_at: '2026-07-07T09:00:00Z',
      }
      // Mirror the REAL Go API (userlog_handler.go): shape chosen by PRESENCE of
      // `?cursor`. With a cursor -> wrapped `{ logs, next_cursor? }`; without ->
      // offset mode returns a BARE ARRAY. The SPA always sends `cursor`, so the
      // bare-array branch is the tripwire that catches a cursor-less regression.
      if (!url.searchParams.has('cursor')) {
        return json(res, 200, [entry])
      }
      return json(res, 200, { logs: [entry] })
    }
    if (path === '/api/v1/logs' && req.method === 'POST') {
      // If the BFF ever proxies an unsafe write here, this counter proves it.
      logsPostCount += 1
      return json(res, 200, { ok: true })
    }

    // --- Test control surface (reachable directly from the test runner) ---
    if (path === '/_control/logs-status') {
      logsStatus = Number(url.searchParams.get('code') ?? 200)
      return json(res, 200, { logsStatus })
    }
    if (path === '/_control/state') {
      return json(res, 200, { logsPostCount, hasMintedToken: lastAccessToken !== null })
    }
    if (path === '/_control/last-forwarding') {
      return json(res, 200, lastForwarding)
    }
    if (path === '/_control/reset') {
      logsStatus = 200
      logsPostCount = 0
      lastForwarding = {}
      return json(res, 200, { ok: true })
    }

    res.writeHead(404)
    res.end()
  })()
})

server.listen(PORT, () => {
  console.log(`stub idp+api listening on ${ISSUER}`)
})
