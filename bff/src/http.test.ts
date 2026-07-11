import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { sendJson, sendEmpty, redirect } from './http.ts'

// Fix 4: every BFF response carries a baseline security-header set so a directly
// exposed BFF (no Caddy in front) is safe on its own. These tests mount the three
// response helpers on a real node:http listener and assert the headers land.

const EXPECTED_SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
}

interface Harness {
  base: string
  close: () => Promise<void>
}

async function mount(handler: Parameters<typeof createServer>[1]): Promise<Harness> {
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function assertSecurityHeaders(res: Response): void {
  for (const [name, value] of Object.entries(EXPECTED_SECURITY_HEADERS)) {
    expect(res.headers.get(name)).toBe(value)
  }
}

describe('http helpers set baseline security headers (fix 4)', () => {
  let h: Harness
  afterEach(async () => {
    await h.close()
  })

  it('sendJson carries the security headers alongside the JSON envelope', async () => {
    h = await mount((_req, res) => sendJson(res, 200, { ok: true }))
    const res = await fetch(h.base)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get('cache-control')).toBe('no-store')
    assertSecurityHeaders(res)
  })

  it('sendEmpty (e.g. 204) carries the security headers', async () => {
    h = await mount((_req, res) => sendEmpty(res, 204))
    const res = await fetch(h.base)
    expect(res.status).toBe(204)
    assertSecurityHeaders(res)
  })

  it('redirect carries the security headers plus Location', async () => {
    h = await mount((_req, res) => redirect(res, '/next'))
    const res = await fetch(h.base, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/next')
    assertSecurityHeaders(res)
  })

  it('a caller-supplied extra header can still override, without dropping the set', async () => {
    h = await mount((_req, res) => sendJson(res, 200, { ok: true }, { 'X-Custom': 'yes' }))
    const res = await fetch(h.base)
    expect(res.headers.get('x-custom')).toBe('yes')
    assertSecurityHeaders(res)
  })
})
