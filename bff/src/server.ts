import { createServer, type RequestListener, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { loadConfig, type BffConfig } from './config.ts'
import { createSessionStore } from './session.ts'
import { createOidc } from './oidc.ts'
import { createAuthRoutes, type AuthRoutes } from './routes/auth.ts'
import { createProxy, type Proxy } from './proxy.ts'
import { sendJson } from './http.ts'

// The composition root: config -> oidc -> routes -> proxy -> HTTP server. This
// is the ONLY module that reads the environment (via loadConfig) and the only
// one wired as a process entrypoint.

export interface AppDeps {
  config: BffConfig
  authRoutes: AuthRoutes
  proxy: Proxy
}

/**
 * Builds the request listener: routing + a privacy-preserving request logger.
 * Pure w.r.t. the environment (deps injected) so it is exercised end-to-end by
 * the E2E suite and could be unit-tested without binding a port.
 */
export function createApp(deps: AppDeps): RequestListener {
  const { authRoutes, proxy } = deps
  return (req, res) => {
    const started = performance.now()
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', deps.config.publicOrigin)
    const path = url.pathname

    // Log method, path, status, and duration ONLY — never headers, never
    // cookies, never tokens. (security.md — no session material in logs.)
    res.on('finish', () => {
      const ms = Math.round(performance.now() - started)
      console.log(`${method} ${path} ${res.statusCode} ${ms}ms`)
    })

    if (path === '/auth/login' && method === 'GET') return void authRoutes.login(req, res)
    if (path === '/auth/callback' && method === 'GET') return void authRoutes.callback(req, res)
    if (path === '/auth/logout' && method === 'POST') return void authRoutes.logout(req, res)
    if (path === '/auth/me' && method === 'GET') return void authRoutes.me(req, res)

    if (path === '/health' || path === '/livez' || path === '/readyz') {
      return void proxy.health(req, res)
    }
    if (path === '/api' || path.startsWith('/api/')) {
      return void proxy.api(req, res)
    }

    sendJson(res, 404, { error: 'not_found', message: 'no such route' })
  }
}

async function main(): Promise<void> {
  const config = loadConfig()
  // Allow http IdP endpoints only when the issuer itself is http (localhost dev
  // / E2E stub). A production https issuer keeps the secure-transport guard on.
  const oidc = await createOidc(config, { allowInsecure: config.issuerUrl.startsWith('http://') })
  const sessions = createSessionStore()
  const authRoutes = createAuthRoutes({ config, oidc, sessions })
  const proxy = createProxy({ config, sessions, oidc })

  const server: Server = createServer(createApp({ config, authRoutes, proxy }))
  server.listen(config.port, () => {
    console.log(`bff listening on :${config.port} (upstream ${config.apiUpstream})`)
  })

  // Graceful shutdown: stop accepting connections, then exit. A hard cap ensures
  // we never hang a deploy if a connection refuses to drain.
  const shutdown = (signal: string): void => {
    console.log(`${signal} received, shutting down`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 5000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

// Run only when executed as the process entrypoint — importing this module (e.g.
// for createApp) has no side effects and never reads the environment.
const isEntrypoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error('bff failed to start:', err)
    process.exitCode = 1
  })
}
