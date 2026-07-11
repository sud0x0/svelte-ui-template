import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseCookies } from './session.ts'

// Thin node:http response/request helpers so routes/auth.ts and proxy.ts stay
// focused on logic, not plumbing. No web framework — the BFF ships zero runtime
// dependencies beyond openid-client (see decisions.md / README).

/** Single request header value, lower-cased name (node already lower-cases keys). */
export function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

/** Parsed request cookies. */
export function cookies(req: IncomingMessage): Record<string, string> {
  return parseCookies(req.headers.cookie)
}

type ExtraHeaders = Record<string, string | string[]>

// Baseline security headers set on EVERY BFF response (fix 4) so a DIRECTLY
// exposed BFF (trustedProxy=false, no Caddy in front) is safe on its own —
// Caddy's edge headers (Caddyfile, security.md rule 7) then become defence in
// depth, not the only line. The BFF serves only JSON and redirects — no HTML, no
// scripts — so the CSP is maximally locked down: nothing may load, and nothing
// may frame it. (Proxied /api/* responses instead pass the Go API's own headers
// through; the Go API sets its own nosniff/CSP.)
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
}

/** Writes a JSON response with the given status. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: ExtraHeaders = {}
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // Authenticated BFF JSON (notably /auth/me's id/email/roles) must never be
    // cached by the browser or an intermediary (ASVS V8.2, fix 10). `extra` can
    // still override per-response if a caller ever needs to.
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extra,
  })
  res.end(payload)
}

/** Writes an empty response (e.g. 204). */
export function sendEmpty(res: ServerResponse, status: number, extra: ExtraHeaders = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, ...extra })
  res.end()
}

/** 302 redirect, optionally setting cookies. */
export function redirect(res: ServerResponse, location: string, setCookies: string[] = []): void {
  const extra: ExtraHeaders = { ...SECURITY_HEADERS, Location: location }
  if (setCookies.length > 0) extra['Set-Cookie'] = setCookies
  res.writeHead(302, extra)
  res.end()
}

// The Go API's error envelope, mirrored EXACTLY so the SPA's existing seam fires
// unchanged: 401 -> client.ts calls login(returnTo); 403 renders in place. See
// go-api-template internal/shared/response.go ({"error","message"}).

/** 401 with the `{"error":"unauthorised", …}` envelope + `WWW-Authenticate: Bearer`. */
export function unauthorised(res: ServerResponse, message: string, extra: ExtraHeaders = {}): void {
  sendJson(res, 401, { error: 'unauthorised', message }, { 'WWW-Authenticate': 'Bearer', ...extra })
}

/** 403 with the `{"error":"forbidden", …}` envelope. */
export function forbidden(res: ServerResponse, message: string, extra: ExtraHeaders = {}): void {
  sendJson(res, 403, { error: 'forbidden', message }, extra)
}
