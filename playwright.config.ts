import { defineConfig, devices } from '@playwright/test'

// E2E covers two surfaces:
//   1. Routing + SPA fallback — run against the production build served by
//      `vite preview` (auth disabled, the default).
//   2. The REAL BFF (bff mode) — a Vite dev server (VITE_AUTH_MODE=bff) whose
//      /api,/auth,/health proxy to a real BFF process, which is a confidential
//      OIDC client against a real stub IdP and proxies /api to a real stub Go
//      API. page.route cannot intercept the BFF's server-side calls, so the IdP
//      and API are real listeners (tests/e2e/stubs/idp-and-api.mjs).
//
// Each surface gets its own web server(s) + project so the two auth modes never
// collide. See tests/e2e/.
const PREVIEW_PORT = 4173 // disabled-mode production build
const STUB_PORT = 4199 // stub IdP + stub upstream API
const BFF_PORT = 4198 // the real BFF under test
const BFF_UI_PORT = 4191 // Vite dev (bff mode), proxying to the BFF

// The BFF's public origin is the UI origin: the browser reaches /auth/* and
// /api/* on the Vite server, which proxies to the BFF, so the OIDC redirect_uri
// (<origin>/auth/callback) and the __Host- cookies must be scoped to the UI origin.
const BFF_PUBLIC_ORIGIN = `http://localhost:${BFF_UI_PORT}`
const CLIENT_ID = 'svelte-ui-bff'
const CLIENT_SECRET = 'e2e-confidential-secret'

const bffEnv = {
  BFF_PORT: String(BFF_PORT),
  BFF_PUBLIC_ORIGIN,
  BFF_ISSUER_URL: `http://localhost:${STUB_PORT}`,
  BFF_API_UPSTREAM: `http://localhost:${STUB_PORT}`,
  BFF_CLIENT_ID: CLIENT_ID,
  BFF_CLIENT_SECRET: CLIENT_SECRET,
  BFF_COOKIE_SECRET: 'e2e-cookie-secret-at-least-32-bytes!!',
  BFF_SCOPES: 'openid profile email',
}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  webServer: [
    {
      // Disabled-mode production bundle for routing tests. Assumes `vite build`
      // has already run (Makefile `test-e2e` builds first); preview serves dist
      // with SPA history fallback.
      command: `pnpm exec vite preview --port ${PREVIEW_PORT} --strictPort`,
      port: PREVIEW_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Stub IdP + stub upstream API (one process, one port).
      command: `node tests/e2e/stubs/idp-and-api.mjs`,
      port: STUB_PORT,
      env: {
        STUB_PORT: String(STUB_PORT),
        BFF_CLIENT_ID: CLIENT_ID,
        BFF_CLIENT_SECRET: CLIENT_SECRET,
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // The REAL BFF. It runs the TypeScript source directly via Node's native
      // type-stripping (Node >= 22.18). wait-for gates startup on the stub's
      // discovery doc, because the BFF discovers the IdP once at boot.
      command: `node tests/e2e/stubs/wait-for.mjs http://localhost:${STUB_PORT}/.well-known/openid-configuration && node bff/src/server.ts`,
      port: BFF_PORT,
      env: bffEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // The SPA in bff mode, proxying /api,/auth,/health to the real BFF.
      command: `pnpm exec vite --port ${BFF_UI_PORT} --strictPort`,
      port: BFF_UI_PORT,
      env: { VITE_AUTH_MODE: 'bff', VITE_API_TARGET: `http://localhost:${BFF_PORT}` },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],

  projects: [
    {
      name: 'routing',
      testMatch: /routing\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PREVIEW_PORT}` },
    },
    {
      name: 'bff',
      testMatch: /bff\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${BFF_UI_PORT}` },
    },
  ],
})
