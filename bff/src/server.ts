import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from 'node:http'
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

// Correlation-id charset + length, mirroring go-api-template's SanitizeRequestID.
// A client-supplied X-Request-ID is UNTRUSTED: it is echoed back on the response,
// forwarded upstream to the Go API, and interpolated into a log line — so an
// unbounded or control-char value would be a log-injection / oversized-log /
// header-reflection vector. Accept only a short opaque token; otherwise mint a
// fresh one (fix 1). The length bound lives in the pattern (`{1,64}`).
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/** Returns the client's X-Request-ID when it is a short, safe token; else a fresh UUID. */
function sanitizeRequestId(raw: string | undefined): string {
  return raw !== undefined && REQUEST_ID_PATTERN.test(raw) ? raw : randomUUID()
}

// Maximum accepted request-body size for /auth/* and /api/* (fix 5). Logs writes
// and auth posts are small JSON; 1 MiB is generous. A declared Content-Length
// over this is refused with 413 before the handler runs, so an oversized upload
// cannot be buffered or streamed upstream. Undeclared (chunked) bodies are further
// bounded by server.requestTimeout (see hardenServer) and the Go API's own limit.
const MAX_BODY_BYTES = 1_048_576

/**
 * Rejects a request whose declared `Content-Length` exceeds `max` with a 413
 * envelope, returning false so the caller skips dispatch. A non-consuming check —
 * it never reads the body — so the /api/* streaming proxy is left intact.
 */
function withinBodyLimit(req: IncomingMessage, res: ServerResponse, max: number): boolean {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > max) {
    sendJson(res, 413, { error: 'payload_too_large', message: 'request body too large' })
    return false
  }
  return true
}

/**
 * Hardens the HTTP server against slow-loris / socket-exhaustion (fix 5). Node's
 * defaults are lenient for an internet-facing edge: bound how long a client may
 * take to send headers and the whole request, and cap keep-alive pipelining per
 * socket. Extracted (and exported) so it is unit-testable without binding a port.
 */
export function hardenServer(server: Server): void {
  server.requestTimeout = 30_000 // the whole request must arrive within 30s
  server.headersTimeout = 10_000 // headers within 10s (slow-loris guard)
  server.maxRequestsPerSocket = 100 // cap keep-alive pipelining per connection
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
    // absent, so the chain UI -> BFF -> Go API is traceable. SANITIZE it first
    // (fix 1) — the inbound value is untrusted and is echoed, forwarded, and
    // logged, so a bad/oversized one is replaced with a fresh UUID. Write it back
    // onto the request so the proxy forwards THIS id upstream, echo it on the
    // response, and include it in the log line. An opaque id, never session material.
    const requestId = sanitizeRequestId(header(req, 'x-request-id'))
    req.headers['x-request-id'] = requestId
    res.setHeader('X-Request-ID', requestId)

    // Log method, path, status, duration, and the correlation id ONLY — never
    // other headers, cookies, or tokens. (security.md — no session material in logs.)
    res.on('finish', () => {
      const ms = Math.round(performance.now() - started)
      console.log(`${method} ${path} ${res.statusCode} ${ms}ms rid=${requestId}`)
    })

    // Body-size cap (fix 5) on the surfaces that accept a body — /auth/* and
    // /api/*. GET routes carry no body so the check is a no-op for them; it is
    // applied uniformly so an oversized POST is refused before any handler runs.
    const isAuth = path.startsWith('/auth/')
    const isApi = path === '/api' || path.startsWith('/api/')
    if ((isAuth || isApi) && !withinBodyLimit(req, res, MAX_BODY_BYTES)) return

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
    if (isApi) {
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
  hardenServer(server) // request/headers timeouts + per-socket request cap (fix 5)
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
