#!/usr/bin/env node
// Serves the built bundle (dist/) through a REAL Caddy using the AUTHORITATIVE
// Caddyfile, over Caddy's internal-CA HTTPS, and asserts the EXACT edge security
// headers Caddy emits (item 5). Unlike the <meta>-tag CSP that `make csp-check`
// exercises, this proves the response HEADERS — including the header-only
// directives a <meta> tag cannot carry (frame-ancestors, HSTS, X-Frame-Options).
// It also runs `caddy validate` on the Caddyfile.
//
// Caddy runs from the pinned `caddy:2-alpine` image via a container runtime
// (docker in CI, podman locally) so no privileged :443 bind or native install is
// needed — the container binds :443 internally and we map it to a high host port.
// Requires a prior `pnpm build` (dist/) and docker OR podman on PATH.
import { spawnSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import https from 'node:https'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Keep in sync with container.prod's caddy stage (same pinned digest).
const CADDY_IMAGE =
  'docker.io/library/caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648'
const HOST_PORT = 18443
const CONTAINER = 'svelte-ui-caddy-header-check'

// The EXACT header strings the Caddyfile promises (security.md rule 7).
const EXPECTED = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  'cross-origin-opener-policy': 'same-origin',
}

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function pickRuntime() {
  for (const rt of ['docker', 'podman']) {
    if (spawnSync(rt, ['--version'], { stdio: 'ignore' }).status === 0) return rt
  }
  fail('no container runtime found (need docker or podman on PATH)')
}

// Verify TLS properly against Caddy's runtime-generated internal root CA (do NOT
// disable verification): read the root the container minted and trust ONLY that.
function readRootCa(runtime, container) {
  const r = spawnSync(
    runtime,
    ['exec', container, 'cat', '/data/caddy/pki/authorities/local/root.crt'],
    { encoding: 'utf8' }
  )
  return r.status === 0 && r.stdout.includes('BEGIN CERTIFICATE') ? r.stdout : null
}

async function waitForRootCa(runtime, container, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const ca = readRootCa(runtime, container)
    if (ca) return ca
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('Caddy internal root CA did not appear in time')
}

function getHeaders(url, ca) {
  return new Promise((res, rej) => {
    // Full TLS verification against the internal CA; SNI is `localhost` (the site).
    const req = https.request(url, { method: 'GET', ca, servername: 'localhost' }, (r) => {
      r.resume()
      res({ status: r.statusCode, headers: r.headers })
    })
    req.on('error', rej)
    req.end()
  })
}

async function waitForReady(url, ca, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      await getHeaders(url, ca)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error('Caddy did not become ready in time')
}

if (!existsSync(resolve(ROOT, 'dist/index.html'))) {
  fail('dist/ not found — run `pnpm build` first')
}

const rt = pickRuntime()
const envArgs = [
  '-e',
  'SITE_ADDRESS=localhost',
  '-e',
  'API_UPSTREAM=localhost:9999',
  '-e',
  'ACME_EMAIL=test@example.com',
  '-e',
  'SITE_ROOT=/srv',
]
const mountArgs = [
  '-v',
  `${resolve(ROOT, 'Caddyfile')}:/etc/caddy/Caddyfile:ro,Z`,
  '-v',
  `${resolve(ROOT, 'dist')}:/srv:ro,Z`,
]

// 1) Validate the authoritative Caddyfile (syntax + adapter). Warnings are OK.
console.log('==> caddy validate')
const validate = spawnSync(
  rt,
  [
    'run',
    '--rm',
    ...mountArgs,
    ...envArgs,
    CADDY_IMAGE,
    'caddy',
    'validate',
    '--config',
    '/etc/caddy/Caddyfile',
    '--adapter',
    'caddyfile',
  ],
  { stdio: 'inherit' }
)
if (validate.status !== 0) fail('caddy validate failed on the Caddyfile')

// 2) Serve dist/ and assert the edge headers over internal-CA HTTPS.
spawnSync(rt, ['rm', '-f', CONTAINER], { stdio: 'ignore' })
console.log('==> starting Caddy to check edge headers')
const server = spawn(
  rt,
  [
    'run',
    '--rm',
    '--name',
    CONTAINER,
    ...mountArgs,
    ...envArgs,
    '-p',
    `${HOST_PORT}:443`,
    CADDY_IMAGE,
    'caddy',
    'run',
    '--config',
    '/etc/caddy/Caddyfile',
    '--adapter',
    'caddyfile',
  ],
  { stdio: 'ignore' }
)

function stopServer() {
  spawnSync(rt, ['rm', '-f', CONTAINER], { stdio: 'ignore' })
  server.kill('SIGKILL')
}

let exitCode = 0
try {
  const url = `https://localhost:${HOST_PORT}/`
  const ca = await waitForRootCa(rt, CONTAINER)
  await waitForReady(url, ca)
  const { status, headers } = await getHeaders(url, ca)
  if (status !== 200) throw new Error(`expected 200 from Caddy, got ${status}`)

  const problems = []
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const actual = headers[name]
    if (actual !== expected) {
      problems.push(`  ${name}:\n    expected: ${expected}\n    actual:   ${actual ?? '(absent)'}`)
    }
  }
  // `-Server` in the Caddyfile removes the Server header.
  if (headers['server'] !== undefined) {
    problems.push(`  server: expected (absent), actual: ${headers['server']}`)
  }

  if (problems.length > 0) {
    console.error(`✗ ${problems.length} edge-header mismatch(es):`)
    console.error(problems.join('\n'))
    exitCode = 1
  } else {
    console.log(
      `✓ Real Caddy emits all ${Object.keys(EXPECTED).length} edge security headers exactly, and -Server.`
    )
  }
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
  exitCode = 1
} finally {
  stopServer()
}

process.exit(exitCode)
