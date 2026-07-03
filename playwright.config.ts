import { defineConfig, devices } from '@playwright/test'

// E2E covers two surfaces:
//   1. Routing + SPA fallback — run against the production build served by
//      `vite preview` (auth disabled, the default).
//   2. The auth-redirect seam — run against a dev server built with
//      VITE_AUTH_MODE=bff, with the BFF endpoints mocked at the network layer.
//
// Each surface gets its own web server + project so the two auth modes never
// collide. See tests/e2e/.
const PREVIEW_PORT = 4173
const BFF_PORT = 4180

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
      // BFF-mode dev server. Auth mode is baked at build time, so the seam test
      // needs its own server with VITE_AUTH_MODE=bff. Endpoints are mocked in
      // the spec via page.route, so no real backend is required.
      command: `pnpm exec vite --port ${BFF_PORT} --strictPort`,
      port: BFF_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { VITE_AUTH_MODE: 'bff' },
    },
  ],

  projects: [
    {
      name: 'routing',
      testMatch: /routing\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PREVIEW_PORT}` },
    },
    {
      name: 'auth-seam',
      testMatch: /auth-redirect\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${BFF_PORT}` },
    },
  ],
})
