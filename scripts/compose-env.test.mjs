// Tripwire for the cross-repo config SEAMS (fixes 1–3): the shipped defaults in
// .env.example and compose.dev.yaml must let the pair connect out of the box.
// These files aren't exercised by the browser/BFF unit suites, so pin their
// invariants here. Run with `node --test scripts/` (make test-scripts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const envExample = readFileSync(new URL('.env.example', root), 'utf8')
const compose = readFileSync(new URL('compose.dev.yaml', root), 'utf8')

// The bff service's `environment:` block (from `  bff:` to the top-level `volumes:`).
const bffEnv = compose.slice(compose.indexOf('\n  bff:'), compose.indexOf('\nvolumes:'))

test('fix 1: BFF_PUBLIC_ORIGIN defaults to the UI origin (:3000), not the BFF port (:8081)', () => {
  // .env.example ships the UI origin.
  assert.match(envExample, /^BFF_PUBLIC_ORIGIN=http:\/\/localhost:3000$/m)
  assert.doesNotMatch(envExample, /^BFF_PUBLIC_ORIGIN=http:\/\/localhost:8081$/m)
  // compose falls back to the UI origin too.
  assert.match(bffEnv, /BFF_PUBLIC_ORIGIN:\s*\$\{BFF_PUBLIC_ORIGIN:-http:\/\/localhost:3000\}/)
})

test('fix 2: compose bff service passes BFF_DEV_INSECURE (so the non-loopback http upstream default boots)', () => {
  assert.match(bffEnv, /BFF_DEV_INSECURE:\s*\$\{BFF_DEV_INSECURE:-true\}/)
  // The compose upstream default is the non-loopback host requireSecureBackendUrl
  // would reject without the escape hatch — so the escape hatch must be present.
  assert.match(
    bffEnv,
    /BFF_API_UPSTREAM:\s*\$\{BFF_API_UPSTREAM:-http:\/\/host\.containers\.internal:8080\}/
  )
})

test('fix 3: compose bff service forwards BFF_AUDIENCE to the container', () => {
  assert.match(bffEnv, /BFF_AUDIENCE:\s*\$\{BFF_AUDIENCE/)
})
