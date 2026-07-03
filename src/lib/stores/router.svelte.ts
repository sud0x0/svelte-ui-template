import type { Component } from 'svelte'

// A small History-API router. URL-driven (deep links work), back/forward via
// popstate, typed route params, a 404 fallback, and route-level code splitting
// (each route is a dynamic `import()` so the initial bundle stays small).
//
// Runes-first: state lives in module-level `$state`, exposed through plain
// accessor functions. (decisions.md)

/** A registered route. `load` is a dynamic import so the chunk is lazy. */
export interface RouteDef {
  pattern: string
  load: () => Promise<{ default: Component }>
  /** When true, the route renders behind <RouteGuard>. */
  guarded?: boolean
}

export interface RouteMatch {
  def: RouteDef
  params: Record<string, string>
}

// --- Pure, testable helpers -------------------------------------------------

/** Normalises a path: leading slash, no trailing slash (except root). */
export function normalisePath(path: string): string {
  let p = path
  if (!p.startsWith('/')) p = '/' + p
  if (p.length > 1) p = p.replace(/\/+$/, '')
  return p || '/'
}

/**
 * Compiles a route pattern (`/`, `/items/:id`) into a matcher. `:name` segments
 * become capture groups; the returned `keys` name them in order.
 */
export function compilePattern(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = []
  const source = normalisePath(pattern)
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1))
        return '([^/]+)'
      }
      // Escape regex metacharacters in literal segments.
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  // No ReDoS risk: `source` is built from developer-defined route patterns (the
  // `routes` table below), never user input. Param segments compile to the
  // linear `([^/]+)` and literal segments are regex-escaped above — there are no
  // nested quantifiers. The matched path is the only user-controlled value, and
  // it is tested against this linear regex.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return { regex: new RegExp(`^${source}$`), keys }
}

/** Returns the first matching route + decoded params, or `null` for none. */
export function matchRoutes(path: string, defs: RouteDef[]): RouteMatch | null {
  const target = normalisePath(path)
  for (const def of defs) {
    const { regex, keys } = compilePattern(def.pattern)
    const result = regex.exec(target)
    if (!result) continue
    const params: Record<string, string> = {}
    keys.forEach((key, i) => {
      params[key] = decodeURIComponent(result[i + 1] ?? '')
    })
    return { def, params }
  }
  return null
}

// --- Route table ------------------------------------------------------------
// One registration site. `/new-route` adds entries here. Order matters: more
// specific patterns first; the NotFound fallback is handled separately.

const routes: RouteDef[] = [
  { pattern: '/', load: () => import('../../routes/Home.svelte'), guarded: true },
  { pattern: '/login', load: () => import('../../routes/Login.svelte') },
]

const NOT_FOUND: RouteDef = {
  pattern: '*',
  load: () => import('../../routes/NotFound.svelte'),
}

// --- Reactive state ---------------------------------------------------------

let path = $state(normalisePath(location.pathname))
let params = $state<Record<string, string>>({})
let component = $state<Component | null>(null)
let guarded = $state(false)
let notFound = $state(false)
let loadError = $state<unknown>(null)

export function currentPath(): string {
  return path
}
export function routeParams(): Record<string, string> {
  return params
}
export function routeComponent(): Component | null {
  return component
}
export function isGuarded(): boolean {
  return guarded
}
export function isNotFound(): boolean {
  return notFound
}
export function routeError(): unknown {
  return loadError
}

/**
 * Resolves a path to a route, lazy-loads its component, and updates state. A
 * stale resolve (superseded by a newer navigation) discards its result via the
 * `path === target` race guard.
 */
async function resolve(to: string): Promise<void> {
  const target = normalisePath(to)
  path = target
  loadError = null

  const matched = matchRoutes(target, routes)
  const def = matched?.def ?? NOT_FOUND
  notFound = matched === null
  guarded = matched?.def.guarded ?? false
  params = matched?.params ?? {}
  component = null

  try {
    const mod = await def.load()
    if (path === target) component = mod.default
  } catch (error) {
    if (path === target) loadError = error
  }
}

/** Navigates to a path, pushing browser history. */
export function navigate(to: string): void {
  const target = normalisePath(to)
  if (target !== normalisePath(location.pathname)) {
    history.pushState({}, '', target)
  }
  void resolve(target)
}

let started = false

/** Wires popstate (back/forward) and resolves the initial URL. Call once. */
export function startRouter(): void {
  if (started) return
  started = true
  window.addEventListener('popstate', () => {
    void resolve(location.pathname)
  })
  void resolve(location.pathname)
}
