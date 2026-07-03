import type { Component } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compilePattern,
  matchRoutes,
  normalisePath,
  navigate,
  currentPath,
  startRouter,
  type RouteDef,
} from '../../src/lib/stores/router.svelte'

// A load thunk that satisfies RouteDef without pulling a real component.
const noopLoad = () => Promise.resolve({ default: null as unknown as Component })

const defs: RouteDef[] = [
  { pattern: '/', load: noopLoad },
  { pattern: '/items/:id', load: noopLoad },
  { pattern: '/items/:id/edit', load: noopLoad },
]

describe('router helpers', () => {
  it('normalises paths (leading slash, trailing slash stripped)', () => {
    expect(normalisePath('items')).toBe('/items')
    expect(normalisePath('/items/')).toBe('/items')
    expect(normalisePath('/')).toBe('/')
    expect(normalisePath('')).toBe('/')
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

  it('popstate (back/forward) updates currentPath', async () => {
    startRouter()
    navigate('/')
    navigate('/login')
    history.back()
    await vi.waitFor(() => expect(currentPath()).toBe('/'))
  })
})
