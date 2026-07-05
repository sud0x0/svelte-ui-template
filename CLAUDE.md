# svelte-ui-template

Production-ready **Svelte 5 (runes) SPA** template — not SvelteKit. The front-end
counterpart to [go-api-template](https://github.com/sud0x0/go-api-template).
Layered architecture (route → `api/client` → store → UI), a **token-free
OIDC/BFF auth seam** (the contract, not an implementation), a hand-rolled
History-API router, runes-first state in `.svelte.ts`, a strict CSP the build
actually satisfies, and a real test harness (Vitest Browser Mode + MSW +
Playwright). Stack, tooling, and a seam — not features.

## Common commands

| Command                | Use for                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make ci`              | **Everyday verification loop** — lint + format + types + unit/component tests + build + bundle-size. Composes the granular targets. Run after every change. |
| `make verify`          | **Full gate** — `ci` + the Playwright E2E suite. Run before a commit/PR.                                                                                    |
| `make run`             | Start the dev container (Vite on :3000; proxies `/api`, `/auth`, `/health` to `VITE_API_TARGET`). Needs **podman**.                                         |
| `make test-unit`       | Vitest browser-mode unit + component tests. Needs **Playwright chromium**.                                                                                  |
| `make test-e2e`        | Playwright E2E (builds first). Needs **Playwright browsers**.                                                                                               |
| `make test-coverage`   | v8 coverage against the documented threshold.                                                                                                               |
| `make csp-check`       | Build + serve + prove the CSP in a real browser (zero violations). Needs **chromium**.                                                                      |
| `make changelog-check` | Confirm CHANGELOG has a non-empty `[X.Y.Z]` section before tagging (`VERSION=x.y.z`).                                                                       |
| `make pre-commit-run`  | Run every pre-commit hook against every file.                                                                                                               |

**Needs podman:** `make run`/`build`/`stop`/`logs`/`destroy`.
**Needs Playwright browsers:** `make ci`/`verify` (via unit + e2e), `test-unit`,
`test-e2e`, `csp-check`. Install once with `pnpm exec playwright install chromium`.
**Needs neither:** `lint`, `fmt`, `check`, `size`, `test-scripts`, `semgrep`.
When a check can't run in your environment, **say so explicitly** in your report —
never imply it passed.

## Project conventions

- **State is runes in `.svelte.ts`** (`$state`/`$derived`) exposed as plain
  accessor functions — never `writable`, never `export let`, never `$:`. The
  store API is only for documented external interop.
- **No tokens in the SPA, ever.** No access/refresh/ID token in any store,
  variable, `localStorage`, or `sessionStorage`. The auth store
  (`lib/stores/auth.svelte.ts`) holds only `CurrentUser`, in memory. The **ID
  token is never sent to `/api`**.
- **All network I/O through `lib/api/client.ts`.** No `fetch` in a route or
  component. The client always sends `credentials: 'include'`, attaches
  `X-CSRF-Token` on unsafe methods, and owns the 401→`login(returnTo)` seam.
- **`VITE_AUTH_MODE` is the auth switch** (`disabled` | `bff`), read only via
  `lib/config.ts` — the single config seam (the one place that reads
  `import.meta.env`).
- **Routes are lazy-loaded** via dynamic `import()` (route-level code splitting),
  registered at the single site in `lib/stores/router.svelte.ts`.
- **Data is loaded outside `$effect`** — an explicit load function or `{#await}`.
  Effects only synchronise with external systems.
- **Theming via CSS variables** in `app.css`; no per-component colour literals.
- **No cross-feature imports**; shared concerns live in `lib/`. **No `any`.**
- **Every new component / route / API resource ships a test.**

## Always-apply rules

- **Never commit — the owner commits, agents never do.** Agents MUST NOT run
  `git commit`, `git tag`, or `git push`. This is non-negotiable and is not
  waived by any task instruction. Leave every change uncommitted in the working
  tree for the repository owner to review and commit. In place of committing,
  **propose a [Conventional Commit](#commit-messages) message per logical change
  in your report** (one per logical change when several are in flight). The
  `Bash(git commit*)` / `Bash(git tag*)` / `Bash(git push*)` entries in the deny
  list of [`.claude/settings.json`](.claude/settings.json) make this mechanical
  as well as documented (that file is itself deny-protected from agent edits by
  design).
- **Run the verification loop and fix failures before moving on.** `make ci`
  must be green after every change; run the full `make verify` (`ci` + e2e)
  before a commit. When Playwright browsers are unavailable, run the no-browser
  subset (`lint`, `check`, `size`, `test-scripts`) and **say so explicitly** —
  never imply the browser-gated checks passed.
- **Read [`.claude/rules/security.md`](.claude/rules/security.md)** before
  touching `api/`, `client.ts`, `auth.ts`, the guards, the router, or the
  `Caddyfile`. Non-negotiable.
- **Read [`.claude/rules/decisions.md`](.claude/rules/decisions.md)** before
  "improving" anything adjacent — it records deliberate trade-offs. Don't
  relitigate them unless the user asks.
- **Agent permissions:** the allow-list in [`.claude/settings.json`](.claude/settings.json)
  holds only durable, non-destructive commands (`make *`, `pnpm *`,
  `svelte-check *`, etc.). One-off approvals (`git checkout`, `pnpm add`, `rm`,
  `curl`, ad-hoc `sed`/`podman`) must NOT be persisted there — approve per session.

## Commit messages

Agents never commit (see the never-commit rule above); this convention is what
the repository **owner** follows, and what agents use when **proposing** a commit
message in their report — never to run `git commit` themselves.

Follow [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):
`type(scope): summary`. Types: `feat`, `fix`, `build`, `ci`, `docs`, `test`,
`perf`, `refactor`, `chore`. Examples:

- `feat(router): add typed route params`
- `fix(client): attach CSRF header only on unsafe methods`
- `docs: document the BFF auth contract`

Breaking changes use `!` after the type/scope **and** a `BREAKING CHANGE:` footer.
This is **requested, not enforced** — there is no commit-msg hook or CI gate that
rejects other formats, and agents must not add one.

**Attribution:** commits must **not** carry `Co-Authored-By: Claude …` trailers or
"Generated with Claude Code" footers — authorship stays with the repository owner.
Enforced for the trailer via `"attribution": { "commit": "", "pr": "" }` in
[`.claude/settings.json`](.claude/settings.json) (empty strings hide all commit/PR
attribution — the current mechanism; the older `"includeCoAuthoredBy"` key is deprecated in favour of attribution); the footer is governed by this rule.

## Skills

- `/new-component` — scaffold a runes component + colocated Vitest Browser test.
- `/new-route` — add a page under `routes/`, register it (lazy `import()`,
  guarded?) at the one router site, add a smoke test.
- `/new-api-resource` — add a typed `lib/api/` module (types first, through
  `client.ts`, guard the response, MSW test).
- `/auth-integration` — complete the seam into a real BFF (flip `VITE_AUTH_MODE`,
  fill the `auth.ts` stubs). Cross-links the Go repo's `r.Route("/api/v1", …)` seam.
- `/security-review` — walk `security.md` with file-cited verdicts; run the scanners.
- `/architecture-review` — check layering, runes-in-`.svelte.ts`, code splitting,
  the auth seam; read `decisions.md` first.
- `/performance-review` — measure bundle size against the budget before changing.
- `/write-unit-tests` — write tests in the repo's discipline: Vitest Browser Mode
  with `vitest-browser-svelte`, MSW at the API boundary, harness fixtures, a
  tripwire per guarded invariant. Keeps the documented v8 coverage threshold
  (decisions.md).
- `/write-comments` — comments as load-bearing context (stale comments are bugs):
  why-not-what, evidence comments, `decisions.md` citations, the `TODO(auth):`
  seam marker, the same-change rule, `TODO(scope): … — <pointer>`.
- `/write-readme` — write README top sections a newcomer can follow: plain
  language, orientation-not-reference, checkable rules (≤3-sentence intro,
  copy-paste-verified quickstart, allowlist-filtered acronym grep, read-aloud pass).
- `/twelve-factor-audit` — audit the SPA against the [12-factor](https://12factor.net/)
  methodology with file-cited, per-factor verdicts, adapted for a static
  build-and-serve frontend (Vite build → tarball → Caddy).

## Releases

Tagging `v*` runs [`.github/workflows/release.yml`](.github/workflows/release.yml):
build → flat tarball (bundle + Caddyfile) → Syft SPDX-JSON SBOM → SHA-256
checksums → GitHub Release → SLSA L3 provenance.

**Changelog discipline.** Release notes are the body of the matching
`## [X.Y.Z]` section in `CHANGELOG.md`, extracted by
[`scripts/extract-changelog.sh`](scripts/extract-changelog.sh). The release
workflow **fails** if that section is missing or empty — commit messages do not
feed the changelog. Keep `## [Unreleased]` current as you ship; before tagging,
move it to a dated `## [X.Y.Z]` section and run `make changelog-check VERSION=x.y.z`.
