import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { worker } from '../mocks/setup'
import { getHealth } from '../../src/lib/api/health'

describe('getHealth', () => {
  it('parses a mocked HealthResponse', async () => {
    worker.use(http.get('/health', () => HttpResponse.json({ status: 'ok', version: '1.2.3' })))
    const health = await getHealth()
    expect(health.status).toBe('ok')
    expect(health.version).toBe('1.2.3')
  })

  // Tripwire (fix 4): the DEFAULT handler must mirror go-api-template's real
  // /health shape — `{ status: 'healthy' }`, never `{ status: 'ok' }`.
  it('the default mock mirrors the real Go API /health shape', async () => {
    const health = await getHealth() // uses the default handler (no worker.use)
    expect(health.status).toBe('healthy')
  })

  it('rejects a malformed body at the boundary', async () => {
    worker.use(http.get('/health', () => HttpResponse.json({ nope: true })))
    await expect(getHealth()).rejects.toThrow(/Malformed HealthResponse/)
  })
})
