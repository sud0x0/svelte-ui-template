import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { worker } from '../mocks/setup'
import { listLogs } from '../../src/lib/api/logs'

const sample = {
  id: 'log-1',
  user_id: 'u-1',
  date_and_time: '2026-07-07T09:00:00Z',
  log: 'did a thing',
  created_at: '2026-07-07T09:00:00Z',
  updated_at: '2026-07-07T09:00:00Z',
}

describe('listLogs', () => {
  it('requests ?limit=10 by default and returns the guarded response', async () => {
    let requestUrl: string | undefined
    worker.use(
      http.get('/api/v1/logs', ({ request }) => {
        requestUrl = request.url
        return HttpResponse.json({ logs: [sample], next_cursor: 'c1' })
      })
    )
    const res = await listLogs()
    expect(new URL(requestUrl!).searchParams.get('limit')).toBe('10')
    expect(res.logs[0]!.log).toBe('did a thing')
    expect(res.next_cursor).toBe('c1')
  })

  it('honours a custom limit', async () => {
    let requestUrl: string | undefined
    worker.use(
      http.get('/api/v1/logs', ({ request }) => {
        requestUrl = request.url
        return HttpResponse.json({ logs: [] })
      })
    )
    await listLogs(5)
    expect(new URL(requestUrl!).searchParams.get('limit')).toBe('5')
  })

  it('rejects a 403 with the forbidden envelope (and does NOT redirect)', async () => {
    const before = location.href
    worker.use(
      http.get('/api/v1/logs', () =>
        HttpResponse.json({ error: 'forbidden', message: 'not authorised' }, { status: 403 })
      )
    )
    await expect(listLogs()).rejects.toMatchObject({ error: 'forbidden' })
    expect(location.href).toBe(before)
  })

  it('throws at the boundary on a malformed body', async () => {
    worker.use(http.get('/api/v1/logs', () => HttpResponse.json({ logs: [{ id: 1 }] })))
    await expect(listLogs()).rejects.toThrow(/Malformed ListLogsResponse/)
  })
})
