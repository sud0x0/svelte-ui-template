import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { playwright } from '@vitest/browser-playwright'

// Unit + component tests run in a REAL browser via Vitest Browser Mode with the
// Playwright provider. jsdom/happy-dom mishandle Svelte 5 runes reactivity, so
// the community recommendation is a real browser. The classic
// @testing-library/svelte + jsdom stack is the documented fallback for
// browserless CI — see .claude/rules/decisions.md.
export default defineConfig({
  test: {
    // Two projects, two runtimes. The SPA is tested in a REAL browser (runes
    // reactivity); the BFF is a Node server, tested in the `node` environment
    // (node:http/node:crypto/openid-client) — a browser can't run it and jsdom
    // would misrepresent it. `pnpm exec vitest run` runs both.
    projects: [
      {
        // SPA — browser mode. The svelte plugin + the test-only publicDir (which
        // serves the MSW worker at /mockServiceWorker.js, kept out of the app's
        // public/ so `vite build` never ships it) are scoped to THIS project.
        plugins: [svelte()],
        publicDir: 'tests/public',
        test: {
          name: 'browser',
          setupFiles: ['./tests/mocks/setup.ts'],
          include: ['tests/unit/**/*.test.ts', 'src/**/*.{test,spec}.ts'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
      {
        // BFF — Node environment. No browser, no MSW; these tests spin up real
        // in-process node:http listeners (stub IdP / stub upstream) so the OIDC
        // and proxy code runs exactly as it will in production.
        test: {
          name: 'bff',
          environment: 'node',
          include: ['bff/src/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,svelte}'],
      // The coverage gate is the SPA logic layer under `src/lib/` (decisions #14).
      // In Vitest projects mode the `bff` project instruments `bff/**` too, and a
      // root-level `include` does NOT scope those out — so `bff/**` is excluded
      // explicitly. That is deliberate, not an omission: the BFF is a separate
      // server component gated by its own 50 behaviour tests (`make bff-test`),
      // the same behaviour-over-line-coverage stance decisions #14 cites for
      // go-api-template's server code — and `bff/src/testutil/` is test
      // scaffolding (a stub IdP) that must never be measured at all.
      // The SPA bootstrap, root shell, and page-level routes are exercised by the
      // Playwright E2E suite, not unit tests, so they are excluded here too.
      exclude: [
        'bff/**',
        'src/main.ts',
        'src/App.svelte',
        'src/routes/**',
        'src/**/*.d.ts',
        'src/vite-env.d.ts',
      ],
      // Documented threshold — CI fails below this. Raise as coverage grows.
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
})
