---
name: performance-review
description: Measure-before-changing performance review of this svelte-ui-template SPA — bundle size against the documented budget, route chunks lazy-loaded, no per-render allocations, no unbounded $effect work. Use when the user says "performance review", "is this fast", "check the bundle size", or "why is the bundle big". A claim without a number is a hypothesis — always measure first.
---

# /performance-review — measure, then review

The rule: **measure before changing.** A claim without a number is a hypothesis.
Read [decisions.md](../../rules/decisions.md) first.

## Step 1 — measure the bundle

```bash
pnpm build        # prints the per-chunk sizes (raw + gzip)
make size         # scripts/check-bundle-size.mjs — total gzipped vs the budget
```

Report the actual numbers: entry chunk size, per-route chunk sizes, total gzipped,
and headroom against the 150 KiB budget in `scripts/check-bundle-size.mjs`. If you
want a treemap, run `rollup-plugin-visualizer` as an **ad-hoc local tool** — never
commit it as a dependency.

## Step 2 — check the structural rules

| Check                    | What good looks like                                                                                 | How                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Route code-splitting     | Each route is its own lazy chunk; the entry doesn't bundle every page.                               | Read `vite build` output — one chunk per `routes/*.svelte`.                           |
| Heavy deps isolated      | Any large dependency added later is its own async chunk, loaded on demand.                           | Inspect the chunk graph; a heavy lib in the entry chunk is a finding.                 |
| No per-render allocation | No new arrays/objects/functions rebuilt every render where a `$derived` or module constant would do. | Read hot components; prefer `$derived` over recomputing in markup.                    |
| Bounded effects          | `$effect`s don't do unbounded work or fetch (fetching belongs in a load fn).                         | `grep -rn '\$effect' src/` — each effect syncs with one external thing and cleans up. |
| Data loading             | Loaded once via a load fn / `{#await}`, not re-fetched on every effect run.                          | Confirm `Home.svelte`'s pattern is followed.                                          |
| Asset caching            | Fingerprinted assets get `immutable` cache headers.                                                  | Confirm the `@assets` block in the `Caddyfile`.                                       |

## Step 3 — report

1. **The numbers** — bundle sizes, chunk counts, budget headroom.
2. **Findings** — each with the measurement that motivates it and the expected
   delta. No speculative micro-optimisations without a number.
3. If nothing measurable is wrong, say so — "within budget, well split, no action"
   is a valid result.

## Non-negotiables

- Measure first. - Don't add a dependency to "optimise" without showing the
  before/after bytes. - Don't break route code-splitting for a marginal gain.
