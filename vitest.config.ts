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
      // The bootstrap, root shell, and page-level route components are exercised
      // by the Playwright E2E suite, not unit tests — exclude them here so the
      // unit-coverage threshold reflects the logic layer (api/stores/utils/
      // components) it actually gates.
      exclude: [
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
