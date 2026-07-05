# svelte-ui-template

A production-ready **Svelte 5 (runes) single-page-app** template — _not_
SvelteKit. It is the front-end counterpart to
[go-api-template](https://github.com/sud0x0/go-api-template) and is built to give
the same first-class LLM-assisted coding experience: a `.claude/` system of rules
and skills, a single verification loop, bounded agent permissions, a real test
layer, and a documented, secure, efficient architecture.

This template ships **stack, tooling, a test harness, and an auth seam — not
features.** There is exactly one tiny reference feature (a `/health` call plus the
auth-seam demo). No tasks, categories, or charts.

> **Authentication is intentionally NOT implemented.** Exactly like the Go
> template, this SPA ships the auth **seam/contract**, not a working login. The
> intended future model is OpenID Connect via a **Backend-For-Frontend (BFF)**
> where the Go API holds the tokens and the SPA holds none. Flipping it on is one
> config flag plus filling a few clearly-marked stubs. See
> [Authentication](#authentication).

---

## Contents

- [Project layout](#project-layout)
- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Authentication](#authentication)
- [Routing](#routing)
- [State](#state)
- [API integration](#api-integration)
- [Theming](#theming)
- [Testing](#testing)
- [Security model](#security-model)
- [Code quality](#code-quality)
- [Releases](#releases)
- [Continuous integration](#continuous-integration)
- [Commit messages](#commit-messages)
- [Makefile reference](#makefile-reference)
- [Changelog](#changelog)
- [TODO](#todo)

---

## Project layout

Layered, one concern per module. Routes orchestrate; `lib/api/*` owns **all**
network I/O through a single client; `lib/stores/*` owns state; `lib/components/*`
are reusable; `lib/utils/*` are pure. No route imports `fetch`.

```
.
├── .claude/                    # agent rules + skills (committed — part of the product)
│   ├── settings.json           # includeCoAuthoredBy:false + durable allow-list
│   ├── rules/{security.md, decisions.md}
│   └── skills/{new-component, new-route, new-api-resource, auth-integration,
│               security-review, architecture-review, performance-review}/SKILL.md
├── .github/workflows/{ci.yml, release.yml}
├── .devcontainer/devcontainer.json
├── public/{favicon.svg, icons.svg, mockServiceWorker.js (generated)}
├── src/
│   ├── App.svelte              # root: nav + router outlet + guard + theme + error boundary
│   ├── main.ts                 # mount
│   ├── app.css                 # theming via CSS variables
│   ├── config.ts               # the ONE place that reads import.meta.env
│   ├── vite-env.d.ts
│   ├── lib/
│   │   ├── api/{client.ts, auth.ts, health.ts}
│   │   ├── stores/{auth.svelte.ts, router.svelte.ts, preferences.svelte.ts}
│   │   ├── components/{ui/Modal.svelte, auth/RouteGuard.svelte}
│   │   ├── types/api.ts        # the API contract + boundary guards
│   │   └── utils/errors.ts
│   └── routes/                 # Home.svelte (guarded), Login.svelte, NotFound.svelte
├── tests/{unit, e2e, mocks}
├── scripts/{check-bundle-size.mjs, check-csp.mjs}
├── Caddyfile                   # reference production host (in the release tarball)
├── compose.dev.yaml + container.dev + container.prod
├── Makefile · CLAUDE.md · CHANGELOG.md · README.md · LICENSE
└── vite/vitest/playwright/eslint/prettier/tsconfig configs
```

## Tech stack

| Concern       | Choice                                                                          | Notes                                                               |
| ------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Framework     | **Svelte 5** (runes: `$state`/`$derived`/`$effect`/`$props`/snippets)           | No SvelteKit — a static SPA behind Caddy.                           |
| Language      | **TypeScript** (strict; `no-explicit-any: error`)                               | Pinned to `~5.9` — TS 6 toolchain support pending (decisions #11).  |
| Build         | **Vite**                                                                        | `:3000`, proxies `/api`/`/auth`/`/health`; CSP-safe build settings. |
| Package mgr   | **pnpm** (frozen lockfile in CI + containers)                                   |                                                                     |
| State         | Runes in `.svelte.ts`, plain accessors                                          | Not `writable`. (decisions #7)                                      |
| Router        | Hand-rolled History-API router                                                  | Params, back/forward, 404, lazy `import()`. (decisions #6)          |
| Tests         | **Vitest Browser Mode** + `vitest-browser-svelte` + **MSW**; **Playwright** E2E | jsdom mishandles runes. (decisions #8)                              |
| Dev container | `node:22-alpine` + pnpm, podman-compose                                         |                                                                     |
| Prod host     | **Caddy** (TLS via Let's Encrypt; `tls internal` for LAN)                       | Reference, not a hard requirement. (decisions #10)                  |
| Supply chain  | Syft SPDX-JSON SBOM at release; `make socket`                                   |                                                                     |
| Runtime deps  | **Zero**                                                                        | Keep it lean — new deps are a supply-chain decision.                |

> Versions are pinned in `package.json` against what was current at authoring
> time (Svelte 5, Vite 8, Vitest 4). Run `pnpm outdated` to review upgrades.

## Quick start

**Prerequisites:** Node 22+ and pnpm 10 (or just podman for the containerised
flow). For the browser-based tests, Playwright's chromium.

```bash
# 1. Install dependencies + generate the MSW worker.
make install                    # or: pnpm install && pnpm exec msw init public --no-save

# 2. Install the test browser (once).
pnpm exec playwright install chromium

# 3. Run the dev server (host).
cp .env.example .env            # then edit VITE_API_TARGET / VITE_AUTH_MODE
pnpm dev                        # http://localhost:3000

#    …or the containerised dev stack (podman):
make setup                      # first time: .env, deps, browsers, hooks, container
make run                        # http://localhost:3000  (make logs to follow)

# 4. The everyday verification loop — run after every change.
make ci          # lint + format + types + unit + build + size
make verify      # the full gate: ci + Playwright E2E (before a commit)
```

## Configuration

Config is read in **one place** — [`src/lib/config.ts`](src/lib/config.ts) (the
dev-proxy target is the single exception, read in `vite.config.ts`). Only
`VITE_`-prefixed, **non-secret** values reach the browser bundle. `.env` is
git-ignored; `.env.example` documents every variable.

| Variable          | Default                                | Purpose                                                                                                                               |
| ----------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_API_TARGET` | `http://host.containers.internal:8080` | Backend the Vite **dev proxy** forwards `/api`, `/auth`, `/health` to. Dev-only — the browser always uses same-origin relative paths. |
| `VITE_AUTH_MODE`  | `disabled`                             | The **auth switch**. `disabled` = no auth (dev user, no-op login). `bff` = wire to the Backend-For-Frontend.                          |

## Authentication

**Status: intentionally NOT implemented — only the seam is.** This mirrors the Go
template's stance: ship the documented contract so the future BFF is a drop-in,
without the template guessing your IdP.

### What exists today (the seam)

- `VITE_AUTH_MODE` flag (`disabled` default).
- `lib/types/api.ts` — the `CurrentUser`, `ApiError`, and `HealthResponse` shapes.
- `lib/api/auth.ts` — `getCurrentUser()` / `login(returnTo?)` / `logout()` as
  **contract-only stubs** with `// TODO(auth)` markers. In `disabled` mode
  `getCurrentUser()` resolves a static dev user so guarded views render;
  `login`/`logout` are documented no-ops.
- `lib/stores/auth.svelte.ts` — holds only the `CurrentUser` profile, **in
  memory, never persisted**.
- `lib/components/auth/RouteGuard.svelte` — the guard boundary, wired into guarded
  routes now. Pass-through in `disabled` mode; the `bff` branch is stubbed and
  captures the intended destination as `returnTo`.
- `lib/api/client.ts` — the single fetch wrapper already (1) sends
  `credentials: 'include'`, (2) attaches `X-CSRF-Token` on unsafe methods, and
  (3) contains the centralised 401→`login(returnTo)` seam.

**No tokens, no PKCE, no OIDC library, no token storage or parsing anywhere in
`src/`.** Flip `VITE_AUTH_MODE=bff` and fill the stubs — that is the entire change.

### Intended future model (documented, not built): BFF, same-origin

The SPA and Go API are **same-origin** behind Caddy, which reverse-proxies
`/api/*`, `/auth/*`, and `/health` to the backend (the browser-based-apps BCP
"same-domain" case). The **Go API is the OIDC client / BFF**: it performs
Authorization Code + PKCE (S256), holds the access/refresh tokens server-side, and
issues the browser a session cookie that is `HttpOnly; Secure; SameSite=Strict`
with the `__Host-` prefix. **The SPA holds no tokens of any kind.**

**The four future `/auth/*` endpoints (BFF-side):**

| Endpoint         | Method | Responsibility                                                                                                                                                                               |
| ---------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/auth/login`    | GET    | Build the OIDC request with PKCE S256, `state` (CSRF on the redirect) and `nonce` (ID-token replay); 302 to the IdP discovered via `.well-known/openid-configuration`. Honour `?return_to=`. |
| `/auth/callback` | GET    | Validate `state`; exchange the code; validate the ID token (JWKS/`kid`, `iss`, `aud`, `exp`, `nbf`, `nonce`, **server-side `alg` allowlist**); set the session cookie.                       |
| `/auth/me`       | GET    | Return the current `CurrentUser` from the server-side session — **never** a token.                                                                                                           |
| `/auth/logout`   | POST   | Clear the session cookie, then RP-initiated logout at the IdP `end_session_endpoint`.                                                                                                        |

**CSRF defence in depth (mandatory in the intended design).** `SameSite=Strict` is
necessary but, per OWASP, must not be the only control. For state-changing requests
the BFF additionally enforces either a **double-submit CSRF token** (BFF sets a
readable `csrf` cookie; the SPA echoes it in `X-CSRF-Token` — this template's
choice, decisions #3) or **Fetch-Metadata** (`Sec-Fetch-Site`) validation. The SPA
attaches the header today.

**The ID token is never an API credential** — it is never sent to `/api`.

### Standards the future implementation must follow

[OAuth 2.0 for Browser-Based Apps](https://datatracker.ietf.org/doc/draft-ietf-oauth-browser-based-apps/),
[RFC 9700 (OAuth 2.0 Security BCP)](https://www.rfc-editor.org/info/rfc9700),
[OAuth 2.1](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/),
[OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html), and the
OWASP [CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html),
[Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html),
and [CSP](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)
cheat sheets.

> **Lockstep with the Go API:** the future BFF resolves the user and sets the UUID
> via `shared.WithUserID` at the **`r.Route("/api/v1", …)`** block in
> `cmd/api/main.go`; handlers read it via `shared.UserIDFromContext`. Implement
> OIDC across both repos together — see the [TODO](#todo) and the
> [`/auth-integration`](.claude/skills/auth-integration/SKILL.md) skill.

## Routing

A small History-API router lives in
[`lib/stores/router.svelte.ts`](src/lib/stores/router.svelte.ts):

- **URL-driven** — the route is read from `location.pathname` on load, so deep
  links work (and the Caddy `try_files {path} /index.html` fallback is meaningful).
- `navigate(path)` uses `history.pushState`; a **popstate** listener makes
  browser back/forward work.
- **Typed route params** (`/items/:id`) parsed via `matchRoutes`.
- A **404 route** for unmatched paths (`NotFound.svelte`).
- **Route-level code splitting** — each route is a dynamic `import()`, so the
  initial bundle stays small.
- The guard's `returnTo` integrates here so post-login navigation can restore the
  intended path.

Add routes with [`/new-route`](.claude/skills/new-route/SKILL.md) — one
registration site.

## State

Runes-first: state modules are `.svelte.ts` files using `$state`/`$derived`,
exposed through plain accessor functions (not the legacy `writable` API). State
that should survive reload (preferences) persists through a thin typed wrapper;
**auth state never persists**. See decisions #7.

## API integration

One request wrapper — [`lib/api/client.ts`](src/lib/api/client.ts):
relative `/api`/`/auth` paths, always `credentials: 'include'`, `X-CSRF-Token` on
unsafe methods, JSON in/out, 204 handling, a typed `ApiError` envelope matching the
Go template's `{"error","message"}` shape, and the centralised 401→`login(returnTo)`
seam. **No retry/refresh logic in the SPA** — the future BFF owns refresh. Add
resources with [`/new-api-resource`](.claude/skills/new-api-resource/SKILL.md).

## Theming

CSS variables in [`app.css`](src/app.css), driven by the preferences store via a
`data-theme` attribute on `<html>`. Light/dark included; no per-component colour
literals.

## Testing

| Layer            | Tooling                                                                 | Covers                                                                                                          |
| ---------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Unit + component | **Vitest Browser Mode** + `vitest-browser-svelte` (Playwright provider) | Real-browser reactivity. `client.ts`, `router.ts`, `health.ts`, `Modal.svelte`, `RouteGuard.svelte`, `auth.ts`. |
| API boundary     | **MSW** (Service Worker)                                                | `credentials:'include'`, CSRF header, 401→login, the health + auth stubs against mocked endpoints.              |
| E2E              | **Playwright**                                                          | Routing (deep link, back/forward, 404, SPA fallback) and the auth-redirect seam (bff build, BFF mocked).        |
| Coverage         | Vitest **v8** with a documented threshold                               | Wired into CI.                                                                                                  |

**Chosen stack rationale + fallback (decisions #8):** jsdom/happy-dom mishandle
Svelte 5 runes reactivity, so unit + component tests run in a **real browser**. The
classic `@testing-library/svelte` + `@testing-library/jest-dom` + `jsdom`/`happy-dom`
stack is the documented fallback for environments that cannot run browsers in CI.

```bash
make test-unit       # browser-mode unit + component (needs chromium)
make test-e2e        # Playwright E2E (builds first; needs browsers)
make test-coverage   # v8 coverage vs the threshold
```

Colocation: tests live under `tests/unit/` (with `tests/unit/fixtures/` harnesses
for snippet-prop components) and `tests/e2e/`; MSW handlers + worker setup live in
`tests/mocks/`.

## Security model

The source of truth is
[`.claude/rules/security.md`](.claude/rules/security.md). Headlines:

- **Token-free BFF auth seam** — the Go API holds tokens; the browser gets an
  `HttpOnly; Secure; SameSite=Strict`, `__Host-` session cookie; the SPA stores no
  token. **CSRF defence in depth** (double-submit `X-CSRF-Token`). **No session
  material in Web Storage.** **The ID token is not an API credential.**
- **A CSP the built bundle actually satisfies:** `script-src 'self'` (no
  `unsafe-inline`/`unsafe-eval`), `default-src 'self'`, `connect-src 'self'`,
  `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`. Achieved
  without a plugin by emitting **no inline scripts** (`modulePreload.polyfill`
  off + `assetsInlineLimit: 0`). `style-src 'self' 'unsafe-inline'` is the
  documented compromise for Vite's runtime CSS injection (decisions #4). The
  policy is in the `Caddyfile` (authoritative) and a `<meta>` tag (for
  `vite preview`). **Proven** by `make csp-check`, not asserted.
- **Edge security headers** in the `Caddyfile`: HSTS (`includeSubDomains`;
  `preload` left off as an operator opt-in), `nosniff`,
  `X-Frame-Options: DENY` + `frame-ancestors 'none'`, `Referrer-Policy`,
  `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `-Server`.
- **Boundary validation** of API JSON, **no secrets in the bundle**, gitleaks +
  semgrep in pre-commit and CI, and dependencies treated as a supply-chain decision.

## Code quality

ESLint (flat config, `no-explicit-any: error`), Prettier, `svelte-check`, and the
pre-commit suite (trailing-whitespace/EOF/yaml/large-files, gitleaks, local
eslint/prettier/svelte-check, semgrep, and an `ensure-node-deps` hook). Bundle
size is gated by [`scripts/check-bundle-size.mjs`](scripts/check-bundle-size.mjs)
(150 KiB gzipped budget) in `make ci` and CI.

## Releases

Tagging `v*` runs [`.github/workflows/release.yml`](.github/workflows/release.yml):
extract release notes from `CHANGELOG.md` → type-check → `vite build` →
bundle-size gate → **flat tarball** (static bundle + `Caddyfile`, so
`tar -xzf … --strip-components=1` lands ready-to-serve) → **Syft SPDX-JSON SBOM**
→ SHA-256 checksums → GitHub Release → **SLSA Level 3 provenance**.

### Release notes come from CHANGELOG.md

The body of the matching `## [X.Y.Z]` section is extracted by
[`scripts/extract-changelog.sh`](scripts/extract-changelog.sh) and used as the
GitHub Release body. The workflow **fails** if that section is missing or empty;
commit messages do not feed the changelog.

### Cutting a release

```bash
# 1. Move the [Unreleased] notes into a new dated section in CHANGELOG.md, e.g.
#    ## [0.2.0] - 2026-07-01
# 2. Confirm the section exists and is non-empty, and that the snapshot builds:
make changelog-check VERSION=0.2.0
make release-check          # build + SBOM + checksums (needs syft)
# 3. Tag and push:
git tag v0.2.0 && git push --tags
```

### Verifying downloads

```bash
VERSION=0.2.0
sha256sum -c checksums.txt                 # cheap — catches corrupted downloads
# SLSA L3 provenance (catches tampered tarballs):
# go install github.com/slsa-framework/slsa-verifier/v2/cli/slsa-verifier@latest
slsa-verifier verify-artifact \
  --provenance-path svelte-ui-template-$VERSION.intoto.jsonl \
  --source-uri github.com/<owner>/<repo> --source-tag v$VERSION \
  svelte-ui-template-$VERSION.tar.gz
```

### Running the bundle

```bash
VERSION=0.2.0
mkdir -p /var/www/app
tar -xzf svelte-ui-template-$VERSION.tar.gz -C /var/www/app --strip-components=1
cd /var/www/app
export SITE_ADDRESS=app.example.com API_UPSTREAM=api.internal:8080 ACME_EMAIL=ops@example.com
caddy run --config Caddyfile
```

**Homeserver / LAN deployments:** replace the `Caddyfile`'s `tls { … }` block with
`tls internal`, delete the `http://{$SITE_ADDRESS}` redirect block, and run
`caddy trust` on each client to install the local CA root.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every PR and push
to `main`, in three jobs:

- **`pre-commit`** — runs every configured hook (`gitleaks`, `semgrep`, eslint,
  prettier, svelte-check) so the local hooks are mandatory server-side too; they
  are skippable locally via `git commit --no-verify`, not here.
- **`test`** — `eslint` → `prettier --check` → type-check → script tests →
  install chromium → Vitest (with coverage) → `vite build` → bundle-size budget
  → Playwright E2E. Coverage and the Playwright report upload as artifacts.
- **`release-validate`** — dry-runs the release packaging (`make prod-bundle`)
  and confirms the CHANGELOG is extractable, so release breakage surfaces on the
  PR rather than at tag time.

## Commit messages

Commits **should** follow [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):
`type(scope): summary`. Types in use: `feat`, `fix`, `build`, `ci`, `docs`, `test`,
`perf`, `refactor`, `chore`. Examples:

- `feat(router): add typed route params`
- `fix(client): attach CSRF header only on unsafe methods`
- `docs: document the BFF auth contract`

Breaking changes use `!` after the type/scope **and** a `BREAKING CHANGE:` footer.
This is **requested, not enforced** — there is no commit-msg hook or CI gate that
rejects other formats (matching go-api-template), and agents must not add one.

**Attribution:** commits must **not** carry `Co-Authored-By: Claude …` trailers or
"Generated with Claude Code" footers. The trailer is disabled via
`"includeCoAuthoredBy": false` in [`.claude/settings.json`](.claude/settings.json).

## Makefile reference

`make help` lists everything, grouped (Development / Testing / Code quality /
Release) with a "Typical workflow" block. Two umbrellas gate every change — each
**composes** the granular targets via `$(MAKE)`, so no command string is
duplicated:

| Target            | Composes                                                               | Needs    |
| ----------------- | ---------------------------------------------------------------------- | -------- |
| **`make ci`**     | `lint` + `fmt-check` + `check` + `test-unit` + `size` (build + budget) | chromium |
| **`make verify`** | `ci` + `test-e2e`                                                      | browsers |

`ci` is the everyday loop (run after every change); `verify` is the full gate
(run before a commit). Granular targets (`lint`, `fmt`, `check`, `test-unit`,
`test-e2e`, `test-coverage`, `test-scripts`, `size`, `csp-check`, `prod-bundle`,
`release-check`, `changelog-check`) each own exactly one command and can be run
on their own. `lint`/`check`/`size`/`test-scripts` need no browser.

## Changelog

[`CHANGELOG.md`](CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Add entries to `## [Unreleased]` as you ship; before tagging, move them into a new
dated `## [X.Y.Z]` section. That section's body becomes the GitHub Release notes
(see [Releases](#releases)) — **commit messages do not feed the changelog**, and a
missing or empty section fails the release.

## TODO

These are intentional gaps a template adopter completes — not missing work:

- **Wire OIDC via the BFF, in lockstep with the Go API.** Flip `VITE_AUTH_MODE=bff`
  and fill the `lib/api/auth.ts` stubs (see
  [`/auth-integration`](.claude/skills/auth-integration/SKILL.md)). The Go side
  resolves the user and calls `shared.WithUserID` at the
  [`r.Route("/api/v1", …)`](https://github.com/sud0x0/go-api-template) seam in
  `cmd/api/main.go`; implement both repos together so the contract matches.
- **Confirm the CSP** for any new asset type you introduce (fonts, images, an
  external API origin → extend `connect-src`/`font-src`); re-run `make csp-check`.
- **Tune the bundle-size budget** in `scripts/check-bundle-size.mjs` as the app grows.
