---
name: new-route
description: Add a new page route in this svelte-ui-template SPA — create the page component under src/routes/, register it in the History router (lazy import(), path/params, guarded or not), and add a smoke test. Use when the user wants a new page/screen/view reachable by URL, e.g. "add a settings page", "add an /items/:id detail route". The router has ONE registration site — src/lib/stores/router.svelte.ts.
---

# /new-route — add a page route

Routes are page components under `src/routes/`, registered in the single route
table in [`router.svelte.ts`](../../../src/lib/stores/router.svelte.ts). Read
[security.md](../../rules/security.md) before adding a guarded route.

## Steps

1. **Create the page.** `src/routes/<Name>.svelte`. It orchestrates: pull state
   from stores, call `lib/api/*` for data — **never** `fetch` directly. Load data
   with an explicit load function + `{#await}`, NOT inside `$effect` (see
   `Home.svelte`). Read params via `routeParams()` from the router.
2. **Register it — one site.** Add an entry to the `routes` array in
   `router.svelte.ts`:
   ```ts
   { pattern: '/items/:id', load: () => import('../../routes/ItemDetail.svelte'), guarded: true },
   ```
   - `pattern`: literal segments + `:name` params. Put more specific patterns
     before looser ones.
   - `load`: a dynamic `import()` so the route is its own lazy chunk (code
     splitting is required).
   - `guarded`: `true` wraps it in `<RouteGuard>` (auth boundary). Public pages
     (like `/login`) omit it.
3. **404 ordering.** Unmatched paths fall through to `NotFound.svelte`
   automatically (the `matchRoutes` → `null` → `NOT_FOUND` path). You don't
   register NotFound; just make sure your `pattern` doesn't accidentally swallow
   other routes.
4. **Navigation.** Link to it with `navigate('/items/42')` or an `<a href>` whose
   click handler calls `navigate` (see `App.svelte`'s nav). Don't use raw
   `<a href>` without the handler — it triggers a full reload.
5. **Smoke test.** Add at least a Playwright spec in `tests/e2e/` asserting the
   deep link resolves and (if guarded) that the seam behaves. For pure logic, add
   a Vitest unit test.

## Verify

`make verify` then `make test-e2e` (needs Playwright browsers). Confirm: deep
link resolves, back/forward work, and an unmatched sibling still hits NotFound.
