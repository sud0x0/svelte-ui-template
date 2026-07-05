import { afterEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { worker } from '../mocks/setup'

// ESM exports can't be spied in browser mode, and `importOriginal` partial
// mocks crash the page on the auth↔client circular import — so fully mock the
// auth module with a plain factory. The client only imports `login`, which is
// all we need to observe here. (Vitest browser limitation.)
vi.mock('../../src/lib/api/auth', () => ({ login: vi.fn() }))

import { request } from '../../src/lib/api/client'
import { login } from '../../src/lib/api/auth'

describe('api client', () => {
  afterEach(() => {
    // Clear the CSRF cookie between tests.
    document.cookie = 'csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
    vi.restoreAllMocks()
  })

  it('sends credentials: include on every request', async () => {
    let credentials: RequestCredentials | undefined
    worker.use(
      http.get('/api/ping', ({ request }) => {
        credentials = request.credentials
        return HttpResponse.json({ ok: true })
      })
    )

    await request('/api/ping')
    expect(credentials).toBe('include')
  })

  it('attaches X-CSRF-Token on unsafe methods and not on GET', async () => {
    document.cookie = 'csrf=tok-123; path=/'
    let postToken: string | null = null
    let getToken: string | null = null
    worker.use(
      http.post('/api/thing', ({ request }) => {
        postToken = request.headers.get('X-CSRF-Token')
        return new HttpResponse(null, { status: 204 })
      }),
      http.get('/api/thing', ({ request }) => {
        getToken = request.headers.get('X-CSRF-Token')
        return HttpResponse.json({})
      })
    )

    await request('/api/thing', { method: 'POST', body: JSON.stringify({ a: 1 }) })
    await request('/api/thing')

    expect(postToken).toBe('tok-123')
    expect(getToken).toBeNull()
  })

  it('sets Content-Type: application/json for a string body', async () => {
    let contentType: string | null = null
    worker.use(
      http.post('/api/json', ({ request }) => {
        contentType = request.headers.get('Content-Type')
        return new HttpResponse(null, { status: 204 })
      })
    )

    await request('/api/json', { method: 'POST', body: JSON.stringify({ a: 1 }) })
    expect(contentType).toBe('application/json')
  })

  it('maps a non-OK JSON body to the typed ApiError envelope', async () => {
    worker.use(
      http.get('/api/boom', () =>
        HttpResponse.json({ error: 'validation', message: 'bad input' }, { status: 400 })
      )
    )

    await expect(request('/api/boom')).rejects.toMatchObject({
      error: 'validation',
      message: 'bad input',
    })
  })

  it('returns undefined for 204 No Content', async () => {
    worker.use(http.delete('/api/thing', () => new HttpResponse(null, { status: 204 })))
    await expect(request('/api/thing', { method: 'DELETE' })).resolves.toBeUndefined()
  })

  it('on 401 triggers login(returnTo) with the current location', async () => {
    history.replaceState({}, '', '/items/42?tab=x')
    worker.use(http.get('/api/secure', () => new HttpResponse(null, { status: 401 })))

    await expect(request('/api/secure')).rejects.toBeTruthy()
    expect(login).toHaveBeenCalledWith('/items/42?tab=x')
  })
})
