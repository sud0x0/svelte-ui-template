import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { playwright } from '@vitest/browser-playwright'

// Unit + component tests run in a REAL browser via Vitest Browser Mode with the
// Playwright provider. jsdom/happy-dom mishandle Svelte 5 runes reactivity, so
// the community recommendation is a real browser. The classic
// @testing-library/svelte + jsdom stack is the documented fallback for
// browserless CI — see .claude/rules/decisions.md.
export default defineConfig({
  plugins: [svelte()],
  // The MSW worker is test-only tooling and must NOT ship in the production
  // bundle (MSW's own docs + the worker header say so). It lives under
  // tests/public/ — never the app's public/ — and this test-only publicDir makes
  // Vitest's browser server serve it at /mockServiceWorker.js. The app build
  // (vite.config.ts) keeps the real public/, so `vite build` never copies it.
  publicDir: 'tests/public',
  test: {
    // MSW worker + any global setup is registered here.
    setupFiles: ['./tests/mocks/setup.ts'],
    include: ['tests/unit/**/*.test.ts', 'src/**/*.{test,spec}.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
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
