---
name: architecture-review
description: Review a change or the whole svelte-ui-template SPA against its layering and architecture rules — route → api/client → store → UI, no cross-feature imports, runes-in-.svelte.ts state, single-source-of-truth config, theming via CSS variables, route-level code splitting, error boundary present, data loaded outside $effect, and the token-free auth seam intact. Use when the user says "architecture review", "does this follow the patterns", or "review the structure of X". Reads decisions.md first and flags contradictions.
---

# /architecture-review — check layering and pattern conformance

**Read [decisions.md](../../rules/decisions.md) first** — a change that
contradicts a settled decision is the finding. Then walk the scope against the
rules below with `file:line` citations.

## Inputs

- **Scope** — a diff, a directory, or the whole `src/`. Default to the working
  tree and say so.

## The checks

| Area                     | Rule                                                                                                                                  | How to check                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Layering                 | Routes orchestrate; `lib/api/*` owns network I/O; `lib/stores/*` owns state; `lib/components/*` are reusable; `lib/utils/*` are pure. | Read imports: no route imports `fetch`; components don't call the network directly.               |
| Single client            | All I/O via `lib/api/client.ts`.                                                                                                      | `grep -rn 'fetch(' src/ \| grep -v client.ts` → nothing.                                          |
| No cross-feature imports | Shared concerns live in `lib/`; feature dirs don't import each other.                                                                 | Inspect import paths across `components/<group>/`.                                                |
| Runes state              | State is `$state`/`$derived` in `.svelte.ts` with plain accessors — no `writable`, no `export let`, no `$:`.                          | `grep -rn 'writable\|export let\|\$:' src/` → nothing (legacy store only for documented interop). |
| Config seam              | `import.meta.env` read in ONE place.                                                                                                  | `grep -rn 'import.meta.env' src/` → only `config.ts` + `vite-env.d.ts`.                           |
| Theming                  | CSS variables from `app.css`; no per-component colour literals.                                                                       | `grep -rnE '#[0-9a-fA-F]{3,6}' src/**/*.svelte` → only in `app.css`.                              |
| Code splitting           | Each route is a dynamic `import()`.                                                                                                   | Read the `routes` table in `router.svelte.ts` — every `load` is `() => import(...)`.              |
| Data loading             | Fetched via a load fn or `{#await}`, NEVER in `$effect`.                                                                              | `grep -rn '\$effect' src/` → effects only sync with DOM/externals, none call `lib/api/*`.         |
| Error boundary           | A top-level `<svelte:boundary>` wraps the router outlet.                                                                              | Confirm in `App.svelte`.                                                                          |
| Auth seam intact         | Token-free; `VITE_AUTH_MODE`; guard + `returnTo` + client 401 + CSRF seams present.                                                   | Confirm `auth.svelte.ts` is profile-only; the `// TODO(auth)` markers exist.                      |

## Output

1. **Conformance table** — `Area → Pass/Gap → citation`.
2. **Findings** — each Gap with `file:line` and the minimal fix; note any item
   that is intentional per `decisions.md` separately.
3. **Contradictions** — anything in the scope that fights a settled decision.

## Non-negotiables

- Cite evidence. - Don't propose a change that contradicts `decisions.md` without
  flagging it as such. - Don't invent new layers; the four (`api`/`stores`/
  `components`/`utils`) are the architecture.
