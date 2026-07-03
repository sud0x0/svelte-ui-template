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

  it('rejects a malformed body at the boundary', async () => {
    worker.use(http.get('/health', () => HttpResponse.json({ nope: true })))
    await expect(getHealth()).rejects.toThrow(/Malformed HealthResponse/)
  })
})
