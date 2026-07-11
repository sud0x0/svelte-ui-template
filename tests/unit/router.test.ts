import type { Component } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compilePattern,
  matchRoutes,
  normalisePath,
  navigate,
  currentPath,
  routeComponent,
  isNotFound,
  startRouter,
  type RouteDef,
} from '../../src/lib/stores/router.svelte'

// A load thunk that satisfies RouteDef without pulling a real component.
const noopLoad = () => Promise.resolve({ default: null as unknown as Component })

const defs: RouteDef[] = [
  { pattern: '/', title: 'Root', load: noopLoad },
  { pattern: '/items/:id', title: 'Item', load: noopLoad },
  { pattern: '/items/:id/edit', title: 'Edit item', load: noopLoad },
]

describe('router helpers', () => {
  it('normalises paths (leading slash, trailing slash stripped)', () => {
    expect(normalisePath('items')).toBe('/items')
    expect(normalisePath('/items/')).toBe('/items')
    expect(normalisePath('/')).toBe('/')
    expect(normalisePath('')).toBe('/')
  })

  it('strips query/hash for route matching (fix 13)', () => {
    expect(normalisePath('/route?x=1')).toBe('/route')
    expect(normalisePath('/route#y')).toBe('/route')
    expect(normalisePath('/route/?x=1')).toBe('/route')
    expect(normalisePath('/a?b#c')).toBe('/a')
    // Params come from the pathname, not the query.
    expect(matchRoutes('/items/42?x=1', defs)?.params).toEqual({ id: '42' })
    expect(matchRoutes('/items/42#frag', defs)?.params).toEqual({ id: '42' })
  })

  it('compiles patterns with named params', () => {
    const { regex, keys } = compilePattern('/items/:id')
    expect(keys).toEqual(['id'])
    expect(regex.test('/items/42')).toBe(true)
    expect(regex.test('/items/42/edit')).toBe(false)
  })

  it('matches a route and parses params', () => {
    const match = matchRoutes('/items/42', defs)
    expect(match?.def.pattern).toBe('/items/:id')
    expect(match?.params).toEqual({ id: '42' })
  })

  it('decodes percent-encoded params', () => {
    const match = matchRoutes('/items/a%20b', defs)
    expect(match?.params).toEqual({ id: 'a b' })
  })

  it('still decodes a valid percent-sequence (%20)', () => {
    const match = matchRoutes('/items/%20', defs)
    expect(match?.params).toEqual({ id: ' ' })
  })

  it('does not throw on a malformed percent-sequence — keeps the raw param', () => {
    // decodeURIComponent('%zz') throws URIError; safeDecode must fall back so a
    // malformed deep link matches (with the raw segment) instead of hanging.
    expect(() => matchRoutes('/items/%zz', defs)).not.toThrow()
    const match = matchRoutes('/items/%zz', defs)
    expect(match?.def.pattern).toBe('/items/:id')
    expect(match?.params).toEqual({ id: '%zz' })
  })

  it('returns null for an unmatched path (drives the 404 route)', () => {
    expect(matchRoutes('/nope/nope', defs)).toBeNull()
  })
})

describe('router navigation', () => {
  afterEach(() => {
    history.replaceState({}, '', '/')
  })

  it('navigate pushes history and updates currentPath', () => {
    navigate('/login')
    expect(location.pathname).toBe('/login')
    expect(currentPath()).toBe('/login')
  })

  it('navigate to a route WITH query/hash resolves the route, keeps it in the URL, and is not 404 (fix 13)', async () => {
    navigate('/login?tab=2')
    // Address bar keeps the query; routing matched the pathname.
    expect(location.pathname).toBe('/login')
    expect(location.search).toBe('?tab=2')
    expect(currentPath()).toBe('/login')
    await vi.waitFor(() => expect(isNotFound()).toBe(false))

    navigate('/login#section')
    expect(location.pathname).toBe('/login')
    expect(location.hash).toBe('#section')
    await vi.waitFor(() => expect(isNotFound()).toBe(false))
  })

  it('popstate (back/forward) updates currentPath', async () => {
    startRouter()
    navigate('/')
    navigate('/login')
    history.back()
    await vi.waitFor(() => expect(currentPath()).toBe('/'))
  })

  it('sets a per-route document.title once the component resolves', async () => {
    navigate('/login')
    await vi.waitFor(() => expect(document.title).toBe('Sign in · Svelte UI Template'))
    navigate('/')
    await vi.waitFor(() => expect(document.title).toBe('Home · Svelte UI Template'))
  })

  it('sets the 404 title for an unmatched route', async () => {
    navigate('/no/such/page')
    await vi.waitFor(() => expect(document.title).toBe('404 — Not Found · Svelte UI Template'))
  })

  it('isNotFound() reflects whether the resolved route matched', async () => {
    // The flag flips in the atomic swap when the lazy load resolves, so wait.
    navigate('/no/such/page')
    await vi.waitFor(() => expect(isNotFound()).toBe(true))
    navigate('/login')
    await vi.waitFor(() => expect(isNotFound()).toBe(false))
  })

  it('keeps the previous component rendered while the next route loads (stale-while-navigating)', async () => {
    navigate('/login')
    await vi.waitFor(() => expect(routeComponent()).not.toBeNull())
    const previous = routeComponent()

    // Kick off the next navigation. resolve() runs synchronously up to the lazy
    // load's first await WITHOUT nulling `component`, so the old route is still
    // rendered right now — no "Loading…" flash between routes.
    navigate('/')
    expect(routeComponent()).toBe(previous)

    // Once the new chunk resolves, the component swaps atomically.
    await vi.waitFor(() => expect(routeComponent()).not.toBe(previous))
    expect(routeComponent()).not.toBeNull()
  })
})
