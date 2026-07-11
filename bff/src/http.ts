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
    ...extra,
  })
  res.end(payload)
}

/** Writes an empty response (e.g. 204). */
export function sendEmpty(res: ServerResponse, status: number, extra: ExtraHeaders = {}): void {
  res.writeHead(status, extra)
  res.end()
}

/** 302 redirect, optionally setting cookies. */
export function redirect(res: ServerResponse, location: string, setCookies: string[] = []): void {
  const extra: ExtraHeaders = { Location: location }
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
