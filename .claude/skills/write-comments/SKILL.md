---
name: write-comments
description: Write and maintain comments the way THIS repo does — comments are load-bearing context for the next reader (human or agent), and a stale comment is a bug. Use when the user says "comment this", "add comments", "document this code", "improve the comments", "add a doc comment", or when reviewing whether new code's comments meet the repo's bar. Enforces TSDoc/JSDoc for .ts and HTML/`//` comments for .svelte, why-not-what for anything non-obvious, evidence comments for verified claims, decisions.md citations where a comment defends a settled trade-off, the auth-seam marker for deliberately-inert code, the same-change rule (a behaviour change updates every comment that describes it, in the same commit), and a TODO(scope) policy. This repo does NOT follow the generic "good code needs no comments" line — that would strip exactly the comments it depends on.
---

# /write-comments — comments as load-bearing context

**Philosophy (read this first).** In this repo, comments are not decoration and
not a code smell. They are the durable record of _why_ the code is the way it is
— the trade-off it defends, the measurement that justifies it, the contract the
next author must not break. The next reader is often an agent with no memory of
the decision. So the bar here is the **opposite** of "good code needs no
comments": under-commenting is a defect, and a **comment that has drifted out of
sync with the code is a bug** — the same severity as a wrong line of code,
because it actively misleads.

The models to imitate are already in the tree; each rule below cites one.

## The rules (each with the repo model)

### 1. Comment syntax by file type

- **`.ts` — TSDoc/JSDoc for exported API.** A doc comment on an exported
  function/type is a `/** … */` block whose first sentence says what it does and
  what it returns; document non-obvious params/throws. Inline rationale uses
  `//`. Models: [`src/lib/api/client.ts`](../../../src/lib/api/client.ts),
  [`src/lib/utils/errors.ts`](../../../src/lib/utils/errors.ts).
- **`.svelte` — `//` in the `<script>`, `<!-- … -->` in markup.** Explain a
  reactive seam or a `$effect` in the script with `//`; annotate a non-obvious
  DOM/ARIA choice in the template with an HTML comment. Model:
  [`src/lib/components/auth/RouteGuard.svelte`](../../../src/lib/components/auth/RouteGuard.svelte).
- Punctuate and capitalise like prose — these render in editors and reviews.

### 2. Why-not-what for anything non-obvious

- Comment the **reason**, not a restatement of the statement. The CSRF block in
  [`client.ts`](../../../src/lib/api/client.ts) explains _why_ the header is
  attached only on unsafe methods and where to swap in Fetch-Metadata — not
  _that_ it sets a header.
- **Evidence comments** — when a claim was actually verified, record the evidence
  so nobody has to re-derive it (the browser/toolchain limitation, the measured
  bundle number, the reason a mock is shaped a certain way). The
  `vi.mock`-rationale comment at the top of
  [`tests/unit/client.test.ts`](../../../tests/unit/client.test.ts) — naming the
  exact Vitest browser-mode limitation — is **the model**.
- **Cite `decisions.md` when a comment defends a settled trade-off** so the next
  reader finds the full rationale instead of re-opening it. Models: the
  "See decisions.md" note on the CSRF choice in
  [`client.ts`](../../../src/lib/api/client.ts), the plain-accessor note in
  [`router.svelte.ts`](../../../src/lib/stores/router.svelte.ts), and the
  `nosemgrep:` line on `compilePattern` (which
  [`decisions.md #13`](../../rules/decisions.md) justifies). Link the entry
  number where one exists.

### 3. The auth-seam marker (this repo's "deliberately inert" marker)

Code that has **no active behaviour by design** — the token-free auth seam that
stays a stub until `VITE_AUTH_MODE` flips to `bff` — carries a `// TODO(auth):`
marker explaining what an adopter wires up there and what it does today (nothing,
on purpose). Models: the stubs in
[`src/lib/api/auth.ts`](../../../src/lib/api/auth.ts), the 401 seam in
[`client.ts`](../../../src/lib/api/client.ts), and the guard branch in
[`RouteGuard.svelte`](../../../src/lib/components/auth/RouteGuard.svelte). This is
the equivalent of go-api-template's `Template surface:` marker: unmarked
inert-looking code reads as a bug; a marked seam is intentional. Its full
rationale is [`decisions.md #1`](../../rules/decisions.md) (OIDC seam only, not
implemented).

### 4. The same-change rule

**Any behaviour change updates every comment and doc that describes that
behaviour, in the same commit.** If you change the bundle-size budget, the CSP,
the CSRF header name, a route, or a default, the comments (and any
`decisions.md`, `security.md`, README, or CHANGELOG line that states the old
value) change with it. Shipping code and its stale comment in the same diff is
the bug this rule exists to prevent. (This mirrors the
[ASVS map's](../security-review/references/asvs-map.md) maintenance rule for its
own rows.)

### 5. What NOT to comment

- **Narration of the obvious.** `i++ // increment i`, `// return the result` —
  delete on sight.
- **Restating the signature.** `// takes a string and returns a boolean` adds
  nothing the declaration doesn't already say. Comment the _why_ or the
  _contract_, not the types (TypeScript already states them).
- **Changelog-style history inside code.** `// 2026-03: changed by X to fix Y`.
  History lives in git and `CHANGELOG.md`, not in a comment that will rot.
  Describe the code as it is now.

### 6. TODO policy

Format: **`TODO(scope): description — <pointer>`**, where `<pointer>` is one of:

- a tracking issue (`— #123`),
- a [`decisions.md`](../../rules/decisions.md) entry (`— see decisions.md #1`), or
- a named, deliberate deferral documented somewhere a reader can find.

**A TODO without a pointer is a finding** — it's an orphaned intention nobody
will ever action. `scope` is the area (`auth`, `perf`, `router`). The in-tree
`TODO(auth):` seam markers (auth.ts, client.ts, RouteGuard.svelte) are the
canonical example — their pointer is the auth-seam decision,
[`decisions.md #1`](../../rules/decisions.md); when you add or touch one, keep the
pointer explicit.

## Verification

Comments have no compiler, so check them by reading:

- `eslint` + `prettier` + `svelte-check` (run by `make ci`) catch malformed
  doc blocks and formatting drift.
- For a behaviour change, **grep the old value/word** across the repo
  (`grep -rn '<old constant/limit/header/route>' .`) to prove no comment, rule
  doc, or README still states the superseded behaviour — that's how you satisfy
  the same-change rule.

## Output format

1. **What changed** — the comments added/updated and the rule each satisfies
   (why-not-what, evidence, decisions cite, auth-seam marker, TODO).
2. **Same-change check** — for any behaviour change, the grep proving no stale
   comment / rule doc / README line remains.
3. **TODOs** — any `TODO(scope): … — <pointer>` added, with the pointer; flag any
   pointer-less TODO found in the scope as a finding.

## Non-negotiables

- **A stale comment is a bug** — fix it in the same change as the code it
  describes.
- **Why, not what** — never narrate the obvious or restate the signature.
- **Every TODO has a pointer**, in `TODO(scope): … — <pointer>` form.
- **`TODO(auth):`** on every deliberately-inert auth-seam stub — nothing else
  tells the next reader the dead-looking code is intentional.
