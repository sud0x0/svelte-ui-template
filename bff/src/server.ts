import { createServer, type RequestListener, type Server, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { loadConfig, type BffConfig } from './config.ts'
import { createSessionStore } from './session.ts'
import { createOidc } from './oidc.ts'
import { createAuthRoutes, type AuthRoutes } from './routes/auth.ts'
import { createProxy, type Proxy } from './proxy.ts'
import { header, sendJson } from './http.ts'

// The composition root: config -> oidc -> routes -> proxy -> HTTP server. This
// is the ONLY module that reads the environment (via loadConfig) and the only
// one wired as a process entrypoint.

export interface AppDeps {
  config: BffConfig
  authRoutes: AuthRoutes
  proxy: Proxy
}

/**
 * Answers a 500 envelope (or destroys the socket if the response is already in
 * flight) and logs — WITHOUT the offending value, which may hold tokens/PII.
 * The last line of defence so a handler bug degrades one request, not the process.
 */
function onHandlerError(res: ServerResponse, err: unknown): void {
  console.error('bff handler error:', err instanceof Error ? err.message : 'unknown')
  if (res.headersSent) {
    res.destroy()
    return
  }
  sendJson(res, 500, { error: 'internal', message: 'internal server error' })
}

/**
 * Invokes a route handler and contains ANY failure — a synchronous throw OR a
 * rejected promise (handlers dispatched as `void handler()` would otherwise leak
 * an unhandledRejection and crash the BFF, e.g. an undici TypeError on an upstream
 * reset). Every failure answers a 500 instead.
 */
function dispatch(res: ServerResponse, handler: () => void | Promise<void>): void {
  try {
    const result = handler()
    if (result instanceof Promise) {
      result.catch((err: unknown) => onHandlerError(res, err))
    }
  } catch (err) {
    onHandlerError(res, err)
  }
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

    // Correlation id (fix 6): use the client's X-Request-ID, or GENERATE one if
    // absent, so the chain UI -> BFF -> Go API is traceable. Write it back onto
    // the request so the proxy forwards THIS id upstream, echo it on the response,
    // and include it in the log line. It is an opaque id, never session material.
    const requestId = header(req, 'x-request-id') ?? randomUUID()
    req.headers['x-request-id'] = requestId
    res.setHeader('X-Request-ID', requestId)

    // Log method, path, status, duration, and the correlation id ONLY — never
    // other headers, cookies, or tokens. (security.md — no session material in logs.)
    res.on('finish', () => {
      const ms = Math.round(performance.now() - started)
      console.log(`${method} ${path} ${res.statusCode} ${ms}ms rid=${requestId}`)
    })

    if (path === '/auth/login' && method === 'GET')
      return dispatch(res, () => authRoutes.login(req, res))
    if (path === '/auth/callback' && method === 'GET')
      return dispatch(res, () => authRoutes.callback(req, res))
    if (path === '/auth/logout' && method === 'POST')
      return dispatch(res, () => authRoutes.logout(req, res))
    if (path === '/auth/me' && method === 'GET') return dispatch(res, () => authRoutes.me(req, res))

    if (path === '/health' || path === '/livez' || path === '/readyz') {
      return dispatch(res, () => proxy.health(req, res))
    }
    if (path === '/api' || path.startsWith('/api/')) {
      return dispatch(res, () => proxy.api(req, res))
    }

    sendJson(res, 404, { error: 'not_found', message: 'no such route' })
  }
}

async function main(): Promise<void> {
  const config = loadConfig()
  // Enable openid-client's insecure-transport path only for an http issuer. This
  // is safe because loadConfig already REJECTS an http issuer unless it is a
  // loopback host or BFF_DEV_INSECURE=true (item 3) — so reaching here with an
  // http issuer already means dev/loopback, never a silent production downgrade.
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
