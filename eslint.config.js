import js from '@eslint/js'
import svelte from 'eslint-plugin-svelte'
import globals from 'globals'
import ts from 'typescript-eslint'
import svelteConfig from './svelte.config.js'

// Flat config per the eslint-plugin-svelte user guide
// (https://sveltejs.github.io/eslint-plugin-svelte/user-guide/) and
// typescript-eslint's typed-linting docs
// (https://typescript-eslint.io/getting-started/typed-linting/).
//
// In eslint-plugin-svelte v3, `svelte.configs.recommended` is a flat-config
// ARRAY — it must be spread at the top level (`...svelte.configs.recommended`),
// not `...svelte.configs.recommended.rules` (which is `undefined`, so no
// `svelte/*` rule runs). Typed linting is enabled via `projectService: true`;
// the Svelte block wires the TS parser + `svelteConfig` so `.svelte` and the
// runes stores in `*.svelte.ts` are type-aware too.
export default ts.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'bff/dist/**',
      'coverage/**',
      'playwright-report/**',
      'tests/public/mockServiceWorker.js',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommendedTypeChecked,
  ...svelte.configs.recommended,
  {
    // Base: browser globals + typed linting via the TS project service.
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-unused-vars': 'off', // disabled in favour of the TS-aware variant
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // No `any` in the template — narrow untrusted data at the boundary instead.
      '@typescript-eslint/no-explicit-any': 'error',
      // The API boundary throws the `ApiError` envelope (a plain object), not an
      // Error instance — a settled design: `isApiError`/`parseApiError` guard it
      // and callers switch on `error.error`. Permit that single type rather than
      // disabling the rule (which still catches every other stray throw). See
      // decisions.md #15.
      '@typescript-eslint/only-throw-error': [
        'error',
        { allow: [{ from: 'file', name: 'ApiError', path: 'src/lib/types/api.ts' }] },
      ],
      'no-undef': 'off', // TypeScript handles undefined identifiers
    },
  },
  {
    // Svelte components AND runes stores in `*.svelte.ts`: Svelte-aware parser
    // with the TS parser underneath, the project's svelteConfig, and typed
    // linting via the project service.
    files: ['**/*.svelte', '**/*.svelte.js', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        extraFileExtensions: ['.svelte'],
        parser: ts.parser,
        svelteConfig,
      },
    },
  },
  {
    // The BFF server (bff/src) is Node code, type-checked via tsconfig.bff.json,
    // so it keeps the typed rules from the base block but swaps browser globals
    // for Node globals (process, Buffer, node:* built-ins).
    files: ['bff/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Node-context config + tooling files use Node globals. scripts/ also runs
    // code inside the browser via Playwright (page.evaluate/addInitScript), so
    // browser globals are allowed there too. These files are not part of a
    // type-checked tsconfig project, so typed rules are disabled here.
    files: [
      '**/*.config.{js,ts}',
      'scripts/**/*.mjs',
      'tests/e2e/**/*.ts',
      'tests/e2e/**/*.mjs',
      'playwright.config.ts',
    ],
    extends: [ts.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  }
)
