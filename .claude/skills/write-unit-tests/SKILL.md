---
name: write-unit-tests
description: Write unit/component tests that match this Svelte SPA template's test discipline. Use when the user says "write tests for X", "add unit tests", "cover this with tests", "test this component/store/api module", or after adding/changing code that needs tests. Enforces Vitest Browser Mode (vitest-browser-svelte) in a real browser, MSW at the API boundary, harness components under tests/unit/fixtures/ for prop/snippet-driven components, behaviour-over-implementation assertions (rendered DOM, thrown/typed errors, store accessors), determinism (no sleeps/wall-clock), and a tripwire proof for every guarded invariant. UNLIKE go-api-template, this repo HAS a documented v8 coverage threshold (vitest.config.ts, enforced in CI) — the skill keeps it and must not remove it (see decisions.md). Cross-references /security-review and the ASVS map for security behaviours.
---

# /write-unit-tests — tests that match this repo's discipline

This repo already has a house style for tests; new tests must look like the ones
already here, not like generic Vitest tests. The reference suites are
[`tests/unit/client.test.ts`](../../../tests/unit/client.test.ts) (the API
boundary via MSW), [`tests/unit/router.test.ts`](../../../tests/unit/router.test.ts)
(the hand-rolled History router), [`tests/unit/RouteGuard.test.ts`](../../../tests/unit/RouteGuard.test.ts)
and [`tests/unit/RouteGuard.bff.test.ts`](../../../tests/unit/RouteGuard.bff.test.ts)
(guard behaviour under each `VITE_AUTH_MODE`), and
[`tests/unit/Modal.test.ts`](../../../tests/unit/Modal.test.ts) (a runes
component rendered through a harness). **Cite the reference each rule mirrors —
every checklist item below names the file that demonstrates it.**

## Inputs

- **Scope** — the component / store / api module to test. If unstated, default to
  the file with uncovered new code in the working tree and say so.
- What invariant(s) the code guards (CSRF header only on unsafe methods, a
  401→`login(returnTo)` redirect, a guard that blocks an unauthenticated route,
  a response rejected at the type boundary). Each becomes a **tripwire** test.

## The checklist (each with the repo model)

### 1. Real-browser rendering, not jsdom

- Unit + component tests run in a **real browser via Vitest Browser Mode** with
  the Playwright provider (`provider: playwright()` in
  [`vitest.config.ts`](../../../vitest.config.ts)). jsdom/happy-dom mishandle
  Svelte 5 runes reactivity — do not reach for them (decisions.md #8).
- Render components with `render` from `vitest-browser-svelte` and query via the
  browser locators (`page`/`getByRole`/`getByText`), asserting with the
  `vitest-browser-svelte` matchers. Model:
  [`Modal.test.ts`](../../../tests/unit/Modal.test.ts).

### 2. Behaviour over implementation

- Assert on the **rendered DOM** (roles, text, presence/absence), on **thrown or
  typed errors** (`ApiError` shape, `isApiError`), on the **navigation the router
  performed** (the current path/params it exposes), and on **store accessor
  return values** — never on private module state or effect internals. Models:
  the response/redirect assertions in
  [`client.test.ts`](../../../tests/unit/client.test.ts), the resolved-route
  assertions in [`router.test.ts`](../../../tests/unit/router.test.ts).
- Error handling asserts on the **typed boundary result** (`parseApiError` /
  `isApiError` / the guard in `lib/types/api.ts`), not on a string message — this
  is how the validate-at-the-boundary rule (security.md rule 8) stays enforced
  by tests.

### 3. Layer rules — pick the double by layer

- **API boundary → MSW.** Never mock `fetch`. Stub the endpoint with
  `worker.use(http.get(…))` from `tests/mocks/` and assert what the client sent
  (`request.credentials === 'include'`, the `X-CSRF-Token` header on unsafe
  methods) and how it parsed the response. Model:
  [`client.test.ts`](../../../tests/unit/client.test.ts) +
  [`tests/mocks/handlers.ts`](../../../tests/mocks/handlers.ts).
- **Components that need props/snippets → a harness component**, not ad-hoc
  inline markup. Colocate a `*Harness.svelte` under
  [`tests/unit/fixtures/`](../../../tests/unit/fixtures/) that supplies the props
  and snippet children, and render the harness. Models:
  [`ModalHarness.svelte`](../../../tests/unit/fixtures/ModalHarness.svelte),
  [`GuardHarness.svelte`](../../../tests/unit/fixtures/GuardHarness.svelte).
- **ESM exports can't be `vi.spyOn`'d in browser mode**, and `importOriginal`
  partial mocks can crash the page on circular imports — so mock a whole module
  with a plain `vi.mock('…', () => ({ … }))` factory that supplies only the
  exports under observation. Model: the `vi.mock('../../src/lib/api/auth', …)`
  at the top of [`client.test.ts`](../../../tests/unit/client.test.ts)
  (decisions.md #8).
- **Config-dependent behaviour → drive it through `lib/config.ts`.** `VITE_AUTH_MODE`
  is read only there; exercise both modes by controlling that seam rather than
  poking `import.meta.env` from the test. Model: the paired
  [`RouteGuard.test.ts`](../../../tests/unit/RouteGuard.test.ts) (disabled) and
  [`RouteGuard.bff.test.ts`](../../../tests/unit/RouteGuard.bff.test.ts) (bff).

### 4. Determinism

- **No `setTimeout`-based sleeps, no wall-clock assertions.** Await the browser
  locators' built-in auto-waiting (`expect.element(...)`), not a fixed delay;
  assert on outcomes, not elapsed time.
- **Reset shared browser state between tests.** Cookies, `localStorage`, and any
  `worker.use` overrides leak across cases — clear them in `afterEach` and call
  `vi.restoreAllMocks()`. Model: the cookie reset + `restoreAllMocks` in
  [`client.test.ts`](../../../tests/unit/client.test.ts).
- **Unit vs E2E split.** Full-page navigation, real history, and CSP live in the
  Playwright E2E suite under [`tests/e2e/`](../../../tests/e2e/) — not in a unit
  test. Keep unit tests to a single component/module/store; never drive a whole
  route through the router in a unit test when an E2E spec is the right home.

### 5. The tripwire proof (mandatory for guarded invariants)

For any test that guards an invariant, **prove it actually guards** it:

1. Temporarily break the invariant in the code under test (drop the
   `X-CSRF-Token` header, remove the 401→login branch, let the guard fall
   through, skip the response type-guard).
2. Run the test; **watch it fail**.
3. Revert the break; confirm it passes again.
4. **Say so in your report** — name the invariant, the edit you made, and that the
   test failed then passed on revert. A test that stays green when the invariant
   is broken is not a test.

## Coverage stance (read this — this repo KEEPS its gate)

**Unlike go-api-template, this repo enforces a v8 coverage threshold** — the
`thresholds` block in [`vitest.config.ts`](../../../vitest.config.ts), run in CI
via `vitest run --coverage`. **This is a deliberate divergence recorded in
[decisions.md #14](../../rules/decisions.md); do not remove, lower, or loosen the
threshold to "match go-api-template".** The logic layer under `src/lib/`
(api/stores/utils/components) is small and pure enough that a coverage floor is
cheap to keep green and meaningful when it drops.

The threshold is a **floor, not the bar**. A file at 80% that skips error paths
is still under-tested. Cover, on top of the percentage:

- the **happy path**,
- **every error path** the code can return (each surfaced through
  `parseApiError` / `isApiError` to its typed shape),
- **boundaries** (empty, unknown route → 404, unsafe vs safe HTTP method,
  guard allow vs block),
- and a **tripwire proof** wherever an invariant is guarded.

When adding genuinely un-unit-testable bootstrap/route surface, prefer extending
the documented `coverage.exclude` list (already excludes `src/main.ts`,
`src/App.svelte`, `src/routes/**`) over lowering the threshold — and justify the
exclusion in the same change.

## Security behaviours get tests as a matter of course

The template's security invariants are enforced _by tests_, and new
security-relevant code must be too — as a matter of course, not on request. The
canonical set already present: **`credentials: 'include'` on every request**,
**`X-CSRF-Token` on unsafe methods only**, **401→`login(returnTo)`**, and
**response validation at the `lib/types/api.ts` boundary**. When testing a change
with a security surface, cross-reference [`/security-review`](../security-review/SKILL.md)
and the [ASVS map](../security-review/references/asvs-map.md) for the requirements
in scope, and add a test per relevant behaviour.

**Record the test in the ASVS map, in the same change.** When a test proves an
ASVS requirement — newly, or by promoting a `met-untested` row — add its name to
that row's **Test evidence** column in
[`asvs-map.md`](../security-review/references/asvs-map.md) as part of the same
change. An untracked security test leaves the map lying about its own coverage.

## Verification

- `make test-unit` — the real-browser Vitest suite (needs Playwright chromium).
  Run after writing.
- `make test-coverage` — the v8 coverage run against the documented threshold;
  run when your change moves coverage.
- `make verify` — when the change has **E2E surface** (routing, guard redirects,
  CSP, anything a Playwright spec should cover); needs Playwright browsers. If
  Playwright browsers are unavailable, run `make test-unit` and **say the
  browser-gated checks were not run** — never imply they passed.

## Output format

1. **What was tested** — the scope and the checklist items covered (happy / each
   error path / boundaries / tripwire).
2. **Tripwire proof** — the invariant, the break you introduced, "failed as
   expected", reverted.
3. **Commands run** — `make test-unit` (and `make test-coverage` / `make verify`,
   or the explicit browser-unavailable note) with the actual result line.

## Non-negotiables

- **Keep the coverage threshold** (decisions.md #14) — never remove or lower it.
- **Behaviour, not internals** — assert on rendered DOM / typed errors /
  navigation / store accessors, not private state.
- **Real browser, deterministic** — no sleeps, no wall-clock, reset shared state.
- **MSW at the API boundary** — never mock `fetch`.
- **Tripwire every guarded invariant** and report it.
