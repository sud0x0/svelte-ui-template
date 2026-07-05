import { defineConfig, loadEnv } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Single source of truth for the dev proxy target. The browser only ever talks
// to same-origin relative paths (/api, /auth, /health); in development Vite
// forwards them to the Go backend so SameSite=Strict cookies behave exactly as
// they will in production behind Caddy. See README "Configuration".
//
// The config MUST be the functional form + loadEnv: Vite does NOT inject `.env*`
// values into `process.env` while the config file itself is evaluated
// (https://vite.dev/config/#using-environment-variables-in-config), so a bare `process.env.VITE_API_TARGET`
// silently ignores the `.env` the README tells you to edit. `loadEnv` reads the
// `.env*` files AND layers the real process env on top (with prefix ''), so the
// container/compose path — which sets VITE_API_TARGET as a real env var — keeps
// winning.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_API_TARGET || 'http://localhost:8080'

  const proxy = {
    target: apiTarget,
    changeOrigin: false,
  }

  return {
    plugins: [svelte()],
    server: {
      port: 3000,
      strictPort: true,
      host: '0.0.0.0',
      proxy: {
        '/api': proxy,
        '/auth': proxy,
        '/health': proxy,
      },
    },
    build: {
      // Keep CSP honest: never inline assets as `data:` URIs. With this at 0 the
      // build emits no `data:` scripts/styles, so `script-src 'self'` holds with
      // no `data:` allowance needed. See .claude/rules/security.md (CSP rule).
      assetsInlineLimit: 0,
      // Drop Vite's inline modulepreload-polyfill <script>. Removing the only
      // inline script the build would otherwise emit lets `script-src 'self'`
      // stay strict (no inline-hash juggling, no plugin). Modern browsers we
      // target support modulepreload natively. See decisions.md.
      modulePreload: { polyfill: false },
    },
  }
})
