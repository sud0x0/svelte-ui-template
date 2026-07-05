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
  /** Human title for `document.title` on this route (see resolve()). */
  title: string
  /** When true, the route renders behind <RouteGuard>. */
  guarded?: boolean
}

/** Suffix appended to every route title: `<route> · Svelte UI Template`. */
const APP_NAME = 'Svelte UI Template'

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

/**
 * `decodeURIComponent`, but crash-proof. The WHATWG URL parser preserves invalid
 * percent-sequences verbatim (a deep link to `/items/%zz` keeps the literal
 * `%zz`), yet `decodeURIComponent('%zz')` throws `URIError`. `matchRoutes` runs
 * OUTSIDE `resolve()`'s try/catch, so an un-decodable param on a `:param` route
 * would reject an un-awaited promise — never setting `loadError`, leaving the UI
 * stuck on "Loading…". Falling back to the raw segment keeps navigation alive.
 */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    // Malformed percent-encoding (URIError). Keep the raw, un-decoded segment.
    return segment
  }
}

// Compile each route's pattern ONCE, not on every navigation. `matchRoutes` runs
// on every resolve(), and `compilePattern` builds a fresh RegExp each call —
// wasteful when the route table is fixed. Memoise per RouteDef object (a WeakMap
// so ad-hoc defs in tests don't leak). `compilePattern` stays exported + tested.
const compiledCache = new WeakMap<RouteDef, { regex: RegExp; keys: string[] }>()

function compiledFor(def: RouteDef): { regex: RegExp; keys: string[] } {
  let compiled = compiledCache.get(def)
  if (!compiled) {
    compiled = compilePattern(def.pattern)
    compiledCache.set(def, compiled)
  }
  return compiled
}

/** Returns the first matching route + decoded params, or `null` for none. */
export function matchRoutes(path: string, defs: RouteDef[]): RouteMatch | null {
  const target = normalisePath(path)
  for (const def of defs) {
    const { regex, keys } = compiledFor(def)
    const result = regex.exec(target)
    if (!result) continue
    const params: Record<string, string> = {}
    keys.forEach((key, i) => {
      params[key] = safeDecode(result[i + 1] ?? '')
    })
    return { def, params }
  }
  return null
}

// --- Route table ------------------------------------------------------------
// One registration site. `/new-route` adds entries here. Order matters: more
// specific patterns first; the NotFound fallback is handled separately.

const routes: RouteDef[] = [
  { pattern: '/', title: 'Home', load: () => import('../../routes/Home.svelte'), guarded: true },
  { pattern: '/login', title: 'Sign in', load: () => import('../../routes/Login.svelte') },
]

const NOT_FOUND: RouteDef = {
  pattern: '*',
  title: '404 — Not Found',
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

/** How a resolve was triggered — decides focus/scroll/title side effects. */
type NavKind = 'initial' | 'push' | 'pop'

/**
 * Moves focus and (on push) scroll to the top of the new screen. Called after a
 * client navigation renders. Per the BBC GEL routing guidance, an SPA route
 * change must move focus to the new screen so assistive tech announces it — we
 * focus the static `<main id="main" tabindex="-1">` wrapper rather than wiring a
 * ref into every route. Scroll resets only on push: on pop the browser restores
 * the previous scroll position, so we must not fight it.
 * https://bbc.github.io/gel/foundations/routing/
 */
function applyNavFocus(kind: NavKind): void {
  if (kind === 'initial') return // never steal focus on first load
  document.getElementById('main')?.focus()
  if (kind === 'push') window.scrollTo(0, 0)
}

/**
 * Resolves a path to a route, lazy-loads its component, and updates state.
 *
 * Stale-while-navigating: we do NOT null `component` at the start, so the CURRENT
 * route stays rendered while the next chunk loads (no "Loading…" flash between
 * routes — that state is reached only on the initial load, when `component` is
 * still null). `path` updates immediately (so `currentPath()`/`aria-current`
 * track the target at once) and `loadError` clears; but `component`, `params`,
 * `guarded`, and `notFound` are applied together as ONE atomic swap only when the
 * lazy load resolves. Applying them atomically matters: if `guarded` flipped
 * before the new component swapped in, the OLD component would briefly render
 * inside/outside the guard. A stale resolve (superseded by a newer navigation)
 * discards its result via the `path === target` race guard.
 */
async function resolve(to: string, kind: NavKind = 'push'): Promise<void> {
  const target = normalisePath(to)
  path = target
  loadError = null

  const matched = matchRoutes(target, routes)
  const def = matched?.def ?? NOT_FOUND
  const nextNotFound = matched === null
  const nextGuarded = matched?.def.guarded ?? false
  const nextParams = matched?.params ?? {}

  try {
    const mod = await def.load()
    if (path === target) {
      // Atomic swap: the new component and its params/guarded/notFound land
      // together so the guard flag never flips ahead of the component.
      component = mod.default
      params = nextParams
      guarded = nextGuarded
      notFound = nextNotFound
      // `def` IS NOT_FOUND on the 404 path (its title is "404 — Not Found"), so
      // `def.title` alone is correct for every route — no 404 special-case needed.
      document.title = `${def.title} · ${APP_NAME}`
      applyNavFocus(kind)
    }
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
  void resolve(target, 'push')
}

let started = false

/** Wires popstate (back/forward) and resolves the initial URL. Call once. */
export function startRouter(): void {
  if (started) return
  started = true
  window.addEventListener('popstate', () => {
    void resolve(location.pathname, 'pop')
  })
  void resolve(location.pathname, 'initial')
}
