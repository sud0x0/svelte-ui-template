import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Single source of truth for the dev proxy target. The browser only ever talks
// to same-origin relative paths (/api, /auth, /health); in development Vite
// forwards them to the Go backend so SameSite=Strict cookies behave exactly as
// they will in production behind Caddy. See README "Configuration".
const apiTarget = process.env.VITE_API_TARGET || 'http://localhost:8080'

const proxy = {
  target: apiTarget,
  changeOrigin: false,
}

export default defineConfig({
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
})
