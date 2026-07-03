import js from '@eslint/js'
import ts from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import svelte from 'eslint-plugin-svelte'
import svelteParser from 'svelte-eslint-parser'
import globals from 'globals'

export default [
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: 2022,
      },
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      '@typescript-eslint': ts,
    },
    rules: {
      ...ts.configs.recommended.rules,
      'no-unused-vars': 'off', // disabled in favour of the TS-aware variant
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // No `any` in the template — narrow untrusted data at the boundary instead.
      '@typescript-eslint/no-explicit-any': 'error',
      'no-undef': 'off', // TypeScript handles this
    },
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tsParser,
      },
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      svelte,
      '@typescript-eslint': ts,
    },
    rules: {
      ...svelte.configs.recommended.rules,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Node-context config + tooling files use Node globals. scripts/ also runs
    // code inside the browser via Playwright (page.evaluate/addInitScript), so
    // browser globals are allowed there too.
    files: ['*.config.{js,ts}', 'scripts/**/*.mjs', 'tests/e2e/**/*.ts', 'playwright.config.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'playwright-report/**',
      'public/mockServiceWorker.js',
    ],
  },
]
