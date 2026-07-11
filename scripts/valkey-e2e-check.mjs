#!/usr/bin/env node
// End-to-end proof that the Valkey-backed BFF session store SURVIVES A RESTART —
// the whole point of BFF_SESSION_STORE=valkey (the in-memory default fails this).
//
// It orchestrates the REAL pieces (no mocks of the store):
//   1. a real Valkey (podman: valkey:8-alpine) on 127.0.0.1:6399,
//   2. the real stub IdP + upstream API (tests/e2e/stubs/idp-and-api.mjs),
//   3. the real BFF (node bff/src/server.ts) with BFF_SESSION_STORE=valkey,
// then drives a full confidential-OIDC login with a hand-rolled cookie jar,
// confirms the session lands in Valkey (inspects the key), makes a proxied /api
// call, RESTARTS the BFF process, and confirms the SAME session cookie still works.
//
// Requires podman on PATH. Usage: `node scripts/valkey-e2e-check.mjs` (or `make valkey-check`).
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const STUB_PORT = 4211
const BFF_PORT = 4212
const VALKEY_PORT = 6399
const VALKEY_CONTAINER = 'svelte-bff-valkey-check'
const VALKEY_IMAGE = 'docker.io/valkey/valkey:8-alpine'
const CLIENT_ID = 'svelte-ui-bff'
const CLIENT_SECRET = 'valkey-e2e-confidential-secret'
const STUB = `http://localhost:${STUB_PORT}`
const BFF = `http://localhost:${BFF_PORT}`
const VALKEY_URL = `redis://127.0.0.1:${VALKEY_PORT}`

const children = []
function fail(msg) {
  console.error(`\n✗ ${msg}`)
  cleanup()
  process.exit(1)
}
function ok(msg) {
  console.log(`  ✓ ${msg}`)
}

function cleanup() {
  for (const c of children) {
    try {
      c.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  spawnSync('podman', ['rm', '-f', VALKEY_CONTAINER], { stdio: 'ignore' })
}
process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(1)
})

// --- tiny cookie jar (we are not a browser; capture Set-Cookie, resend Cookie) ---
const jar = new Map()
function stashCookies(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const eq = pair.indexOf('=')
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (value === '') jar.delete(name)
    else jar.set(name, value)
  }
}
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}
async function req(url, { method = 'GET', headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(jar.size ? { cookie: cookieHeader() } : {}), ...headers },
    redirect: 'manual',
  })
  stashCookies(res)
  return res
}

async function waitFor(label, fn, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await fn()) return
    } catch {
      /* not up yet */
    }
    await sleep(150)
  }
  fail(`timed out waiting for ${label}`)
}

function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts })
  children.push(child)
  return child
}

function startBff() {
  return run('node', ['bff/src/server.ts'], {
    env: {
      ...process.env,
      BFF_PORT: String(BFF_PORT),
      BFF_PUBLIC_ORIGIN: BFF,
      BFF_ISSUER_URL: STUB,
      BFF_API_UPSTREAM: STUB,
      BFF_CLIENT_ID: CLIENT_ID,
      BFF_CLIENT_SECRET: CLIENT_SECRET,
      BFF_COOKIE_SECRET: 'valkey-e2e-cookie-secret-at-least-32b!',
      BFF_SCOPES: 'openid profile email',
      BFF_SESSION_STORE: 'valkey',
      BFF_VALKEY_URL: VALKEY_URL,
    },
  })
}

function valkeyKeys(pattern) {
  const r = spawnSync(
    'podman',
    ['exec', VALKEY_CONTAINER, 'valkey-cli', '--scan', '--pattern', pattern],
    { encoding: 'utf8' }
  )
  return (r.stdout ?? '').split('\n').filter(Boolean)
}

async function main() {
  if (spawnSync('podman', ['--version'], { stdio: 'ignore' }).status !== 0) {
    fail('podman is required on PATH for this check')
  }

  console.log('==> starting Valkey (podman)')
  spawnSync('podman', ['rm', '-f', VALKEY_CONTAINER], { stdio: 'ignore' })
  const up = spawnSync('podman', [
    'run',
    '-d',
    '--rm',
    '--name',
    VALKEY_CONTAINER,
    '-p',
    `127.0.0.1:${VALKEY_PORT}:6379`,
    VALKEY_IMAGE,
  ])
  if (up.status !== 0) fail('could not start the Valkey container')
  await waitFor('valkey', () =>
    spawnSync('podman', ['exec', VALKEY_CONTAINER, 'valkey-cli', 'ping'], {
      encoding: 'utf8',
    }).stdout.includes('PONG')
  )
  ok('valkey is up')

  console.log('==> starting stub IdP + API')
  run('node', ['tests/e2e/stubs/idp-and-api.mjs'], {
    env: {
      ...process.env,
      STUB_PORT: String(STUB_PORT),
      BFF_CLIENT_ID: CLIENT_ID,
      BFF_CLIENT_SECRET: CLIENT_SECRET,
    },
  })
  await waitFor(
    'stub idp',
    async () => (await fetch(`${STUB}/.well-known/openid-configuration`)).ok
  )
  ok('stub idp + api is up')

  console.log('==> starting BFF #1 (BFF_SESSION_STORE=valkey)')
  let bff = startBff()
  await waitFor('bff #1', async () => (await fetch(`${BFF}/health`)).ok)
  ok('bff #1 is up (session store: valkey)')

  console.log('==> driving a real confidential-OIDC login')
  // 1) /auth/login → 302 to the IdP /authorize (captures __Host-txn).
  let res = await req(`${BFF}/auth/login?return_to=${encodeURIComponent('/')}`)
  if (res.status !== 302) fail(`/auth/login expected 302, got ${res.status}`)
  const authorizeUrl = res.headers.get('location')

  // 2) IdP /authorize → HTML login page; extract the consent link (HTML-escaped).
  const page = await (await fetch(authorizeUrl)).text()
  const hrefMatch = page.match(/href="([^"]+)"/)
  if (!hrefMatch) fail('could not find the consent link on the stub login page')
  const consentPath = hrefMatch[1].replace(/&amp;/g, '&')

  // 3) /authorize/consent → 302 back to the BFF /auth/callback?code&state.
  res = await fetch(new URL(consentPath, STUB), { redirect: 'manual' })
  const callbackUrl = res.headers.get('location')
  if (!callbackUrl || !callbackUrl.includes('/auth/callback'))
    fail('consent did not redirect to /auth/callback')

  // 4) /auth/callback → creates the session in Valkey, sets __Host-session + csrf.
  res = await req(callbackUrl)
  if (res.status !== 302) fail(`/auth/callback expected 302, got ${res.status}`)
  if (!jar.has('__Host-session')) fail('no __Host-session cookie was set by the callback')
  ok('login completed; __Host-session cookie issued')

  // 5) /auth/me works.
  res = await req(`${BFF}/auth/me`)
  if (res.status !== 200) fail(`/auth/me expected 200, got ${res.status}`)
  const me = await res.json()
  ok(`/auth/me → 200 (${me.displayName})`)

  // 6) proxied /api call works (proves the BFF attached the server-side bearer).
  res = await req(`${BFF}/api/v1/logs?cursor=&limit=10`)
  if (res.status !== 200) fail(`proxied /api/v1/logs expected 200, got ${res.status}`)
  ok('proxied /api/v1/logs → 200 (BFF attached the server-side access token)')

  // 7) confirm the session actually LIVES IN VALKEY (inspect the key).
  const sessKeys = valkeyKeys('bff:sess:*')
  if (sessKeys.length < 1) fail('expected a bff:sess:* key in Valkey, found none')
  ok(`session persisted in Valkey: ${sessKeys[0]}`)

  // 8) RESTART the BFF process — the in-memory store would LOSE the session here.
  console.log('==> restarting the BFF process (kill + fresh start)')
  await new Promise((resolve) => {
    bff.once('exit', resolve)
    bff.kill('SIGKILL')
  })
  bff = startBff()
  await waitFor('bff #2', async () => (await fetch(`${BFF}/health`)).ok)
  ok('bff #2 is up (fresh process, same Valkey)')

  // 9) THE PROOF: the SAME session cookie still authenticates after the restart.
  res = await req(`${BFF}/auth/me`)
  if (res.status !== 200)
    fail(`after restart, /auth/me expected 200, got ${res.status} — SESSION DID NOT SURVIVE`)
  ok('after restart, /auth/me → 200 — SESSION SURVIVED the BFF restart')

  res = await req(`${BFF}/api/v1/logs?cursor=&limit=10`)
  if (res.status !== 200) fail(`after restart, proxied /api expected 200, got ${res.status}`)
  ok('after restart, proxied /api/v1/logs → 200 (refresh/tokens intact in Valkey)')

  console.log('\n✓ Valkey restart-survival check PASSED')
  cleanup()
  process.exit(0)
}

main().catch((err) => fail(err?.message ?? String(err)))
