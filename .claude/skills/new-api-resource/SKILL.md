---
name: new-api-resource
description: Add a typed API resource module under src/lib/api/ in this svelte-ui-template repo — define request/response types, call only through client.ts (credentials:'include' + CSRF on unsafe methods), guard the response at the boundary, surface errors via parseApiError, and add an MSW-backed test. Use when wiring the SPA to a new backend endpoint, e.g. "add the orders API", "call GET /api/v1/items". No fetch outside the client.
---

# /new-api-resource — add a typed API module

All network I/O goes through [`client.ts`](../../../src/lib/api/client.ts). A
resource module is a thin typed wrapper over `request<T>()`. [`health.ts`](../../../src/lib/api/health.ts)
is the minimal reference. **Read [security.md](../../rules/security.md) first** —
rules 1, 2, 3, 8 apply to every endpoint.

## Steps

1. **Types first.** Add request/response interfaces to
   [`types/api.ts`](../../../src/lib/types/api.ts), matching the Go API contract.
   Add a boundary guard (`assertX` / `isX`) that narrows untrusted JSON — see
   `assertHealthResponse`.
2. **Module under `lib/api/`.** `src/lib/api/<resource>.ts`. Each function calls
   `request<T>()` with a same-origin relative path (`/api/v1/...`). Never call
   `fetch` directly.
   ```ts
   import { request } from './client'
   import { assertItem, type Item } from '../types/api'
   export async function getItem(id: string): Promise<Item> {
     return assertItem(await request<unknown>(`/api/v1/items/${encodeURIComponent(id)}`))
   }
   export async function createItem(input: NewItem): Promise<Item> {
     return assertItem(
       await request<unknown>('/api/v1/items', {
         method: 'POST',
         body: JSON.stringify(input),
       })
     )
   }
   ```
3. **The client already handles the seam.** `credentials: 'include'`, the
   `X-CSRF-Token` header on unsafe methods, and the 401→login path are all in
   `client.ts` — do NOT re-implement them per resource.
4. **Errors.** Callers surface failures via `parseApiError`/`errorMessage` from
   `lib/utils/errors.ts`. Don't swallow errors in the resource module; let them
   propagate as the typed `ApiError`.
5. **Test with MSW.** Add `tests/unit/<resource>.test.ts`. Register handlers via
   `worker.use(http.get('/api/v1/items/1', …))` and assert the parse + guard.
   Cover at least one happy path and one malformed-body rejection.

## Pitfalls

- [ ] Path-param values go through `encodeURIComponent`.
- [ ] `request<unknown>(…)` then `assertX(...)` — don't `request<Item>` and skip
      the guard; that trusts the server blindly.
- [ ] No `any`. Narrow `unknown` via the guard.

## Verify

`make verify` — the new module's MSW test runs under unit tests.
