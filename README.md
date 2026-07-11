# svelte-ui-template

> Please note that this project is still under development.

A **Svelte 5 (runes) single-page-app** template — _not_
SvelteKit. It is the front-end counterpart to
[go-api-template](https://github.com/sud0x0/go-api-template) and is built to give
the same first-class LLM-assisted coding experience: a `.claude/` system of rules
and skills, a single verification loop, bounded agent permissions, a real test
layer, and a documented, secure, efficient architecture.

This template ships **stack, tooling, a test harness, and a real auth model — not
features.** There is one tiny reference feature (a `/health` call plus an
authenticated "Recent logs" list). No tasks, categories, or charts.

> **Authentication is implemented — as a token-free Backend-for-Frontend (BFF).**
> The SPA holds **no tokens of any kind**. A small confidential-client OIDC
> service (`bff/`) logs the user in with Authorization Code + PKCE, keeps every
> token server-side, gives the browser only a `__Host-` session cookie, and
> proxies `/api/*` to [go-api-template](https://github.com/sud0x0/go-api-template)
> with the access token attached. This is the top-ranked architecture of the
> IETF's browser-apps Best Current Practice. `VITE_AUTH_MODE` switches between
> `disabled` (dev, no auth) and `bff` (live, end-to-end tested). See
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
│   ├── settings.json           # attribution disabled + scoped allow-list + deny list
│   ├── rules/{security.md, decisions.md}
│   └── skills/{new-component, new-route, new-api-resource, auth-integration,
│               security-review, architecture-review, performance-review,
│               twelve-factor-audit, write-comments, write-readme,
│               write-unit-tests}/SKILL.md
├── .github/workflows/{ci.yml, release.yml}
├── .devcontainer/devcontainer.json
├── public/{favicon.svg, icons.svg}
├── src/
│   ├── App.svelte              # root: nav + router outlet + guard + theme + error boundary
│   ├── main.ts                 # mount
│   ├── app.css                 # theming via CSS variables
│   ├── vite-env.d.ts
│   ├── lib/
│   │   ├── config.ts           # the ONE place that reads import.meta.env
│   │   ├── api/{client.ts, auth.ts, health.ts, logs.ts}
│   │   ├── stores/{auth.svelte.ts, router.svelte.ts, preferences.svelte.ts}
│   │   ├── components/{ui/Modal.svelte, auth/RouteGuard.svelte}
│   │   ├── types/api.ts        # the API contract + boundary guards
│   │   └── utils/errors.ts
│   └── routes/                 # Home.svelte (guarded), Login.svelte, NotFound.svelte
├── bff/                        # the confidential-client OIDC BFF (Node/TypeScript)
│   ├── src/{config,session,csrf,oidc,proxy,http,server}.ts + routes/auth.ts
│   └── README.md               # pointer to the README Authentication section
├── tests/{unit, e2e (+ e2e/stubs/idp-and-api.mjs), mocks, public/mockServiceWorker.js (generated)}
├── scripts/{check-bundle-size.mjs, check-csp.mjs, extract-changelog.sh,
│            extract-changelog.test.mjs}
├── Caddyfile                   # reference production host (in the release tarball)
├── compose.dev.yaml + container.{dev, prod, bff}
├── Makefile · CLAUDE.md · CHANGELOG.md · README.md · LICENSE
└── vite/vitest/playwright/eslint/prettier/tsconfig(+ tsconfig.bff) configs
```

## Tech stack

| Concern       | Choice                                                                          | Notes                                                                               |
| ------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Framework     | **Svelte 5** (runes: `$state`/`$derived`/`$effect`/`$props`/snippets)           | No SvelteKit — a static SPA behind Caddy.                                           |
| Language      | **TypeScript** (strict; `no-explicit-any: error`)                               | Pinned to `~5.9` — TS 6 toolchain support pending (decisions #11).                  |
| Build         | **Vite**                                                                        | `:3000`, proxies `/api`/`/auth`/`/health`; CSP-safe build settings.                 |
| Package mgr   | **pnpm** (frozen lockfile in CI + containers)                                   |                                                                                     |
| State         | Runes in `.svelte.ts`, plain accessors                                          | Not `writable`. (decisions #7)                                                      |
| Router        | Hand-rolled History-API router                                                  | Params, back/forward, 404, lazy `import()`. (decisions #6)                          |
| Tests         | **Vitest Browser Mode** + `vitest-browser-svelte` + **MSW**; **Playwright** E2E | jsdom mishandles runes. (decisions #8)                                              |
| Dev container | `node:22-alpine` + pnpm, podman-compose                                         |                                                                                     |
| Prod host     | **Caddy** (TLS via Let's Encrypt; `tls internal` for LAN)                       | Reference, not a hard requirement. (decisions #10)                                  |
| Supply chain  | Syft SPDX-JSON SBOM at release; `make socket`                                   |                                                                                     |
| Runtime deps  | Browser bundle **zero**; BFF **one** (`openid-client`)                          | Browser stays dependency-free; the BFF admits one audited OIDC lib (decisions #17). |

> Versions are pinned in `package.json` against what was current at authoring
> time (Svelte 5, Vite 8, Vitest 4). Run `pnpm outdated` to review upgrades.

## Quick start

**Prerequisites:** Node 22+ and pnpm 10 (or just podman for the containerised
flow). For the browser-based tests, Playwright's chromium.

```bash
# 1. Install dependencies + generate the MSW worker.
make install                    # or: pnpm install && pnpm exec msw init tests/public --no-save

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

| Variable          | Default                                | Purpose                                                                                                                                                                                                                                                                                |
| ----------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_API_TARGET` | `http://host.containers.internal:8080` | Backend the Vite **dev proxy** forwards `/api`, `/auth`, `/health` to. Dev-only — the browser always uses same-origin relative paths. In `bff` mode this points at the **BFF** (`http://bff:8081` in-compose, `http://localhost:8081` bare-metal), which in turn points at the Go API. |
| `VITE_AUTH_MODE`  | `disabled`                             | The **auth switch** (`src/lib/config.ts`). `disabled` = no auth (static dev user, no-op login). `bff` = live login through the BFF.                                                                                                                                                    |

The BFF is configured separately by its own `BFF_*` variables (server-side, never
in the browser bundle) — see the [Authentication](#authentication) env table and
`.env.example`.

## Authentication

**Status: implemented as a token-free Backend-for-Frontend (BFF).** The SPA holds
**no tokens**; the BFF (`bff/`, Node/TypeScript) is the confidential OIDC client
and holds them all. This is the top-ranked architecture of
[OAuth 2.0 for Browser-Based Apps](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps)
(§6.1) — an IESG-approved Best Current Practice in the RFC-Editor queue, not "just
a draft".

### The architecture, in one line

```
Browser (SPA, no tokens)  →  Caddy  →  BFF (confidential OIDC client, holds tokens)  →  Go API
                                          └─ Authorization Code + PKCE with the IdP (server-side)
```

Everything is **same-origin** behind Caddy, which reverse-proxies `/api/*`,
`/auth/*`, and `/health`. The browser only ever calls same-origin relative paths,
so **`connect-src 'self'` in the CSP is unchanged** — the IdP round trip is a
top-level navigation, not a `fetch`, and the token exchange happens server-side in
the BFF. That is the headline security win: no token ever enters the browser, so
XSS cannot exfiltrate one.

### Modes (`VITE_AUTH_MODE`)

| Mode       | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disabled` | No auth. `getCurrentUser()` resolves a static dev user so guarded views render; `login`/`logout` are no-ops. The auth seam is inert. Good for pure-frontend dev. **Caveat:** the SPA sends no credential in this mode, so pointing it at a **real, auth-enabled Go API** makes authenticated resources 401 — the Home "Recent logs" card will show its error state. That is expected: run `bff` mode for real auth, or use `disabled` mode with a mock/no backend for pure UI work. |
| `bff`      | Live login through the BFF. `login()` navigates to `/auth/login`; `getCurrentUser()` calls `/auth/me`; `logout()` POSTs `/auth/logout`. The browser holds only the `__Host-` session cookie. E2E-tested.                                                                                                                                                                                                                                                                            |

### The BFF's `/auth/*` and proxy endpoints

| Endpoint                       | Method | Responsibility                                                                                                                                                                                                                                           |
| ------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/auth/login`                  | GET    | Validate `?return_to=` (same-site relative only); create a login transaction (state, nonce, PKCE verifier) in a `__Host-txn` cookie; 302 to the IdP with `code_challenge_method=S256`.                                                                   |
| `/auth/callback`               | GET    | Consume the transaction **once**; validate `state`; exchange the code with client secret + PKCE verifier; validate the ID token (JWKS, `iss`, `aud`, `exp`, `nonce`); create the session; set cookies; 302 to the validated `return_to`.                 |
| `/auth/me`                     | GET    | With a session: `{id, displayName, email?, roles}` mapped from the ID-token claims (mirrors go-api-template's `mapClaimsToRoles`). No session: the Go `401 {"error":"unauthorised"}` envelope, so the SPA's 401 seam fires. **Never** returns a token.   |
| `/auth/logout`                 | POST   | CSRF-protected. Destroy the session, expire both cookies; `200 {"logout_url"}` for RP-initiated logout when the IdP advertises `end_session_endpoint`, else `204`.                                                                                       |
| `/api/*`                       | any    | Authenticated reverse proxy: strip inbound `Authorization`/`Cookie`, attach `Authorization: Bearer <access token>` from the session, refresh (single-flight, rotated) within 30 s of expiry, stream status + body through untouched (`403` stays `403`). |
| `/health`, `/livez`, `/readyz` | GET    | Unauthenticated passthrough to the Go API.                                                                                                                                                                                                               |

### The BFF's environment (`BFF_*` — server-side, never in the bundle)

| Variable              | Default                 | Purpose                                                                                                                                                                                                                                                                                              |
| --------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BFF_PORT`            | `8081`                  | TCP port the BFF listens on.                                                                                                                                                                                                                                                                         |
| `BFF_PUBLIC_ORIGIN`   | _(required)_            | Absolute **UI origin** the browser reaches the BFF _through_ (Vite `:3000` in dev, Caddy in prod) — **not** the BFF's own `:8081`. `redirect_uri` is derived as `<origin>/auth/callback` and the `__Host-` cookies scope to it. Dev default `http://localhost:3000`.                                 |
| `BFF_ISSUER_URL`      | _(required)_            | OIDC issuer URL for discovery (`<issuer>/.well-known/openid-configuration`). **Must be `https://`** except for a loopback host (see `BFF_DEV_INSECURE`).                                                                                                                                             |
| `BFF_CLIENT_ID`       | _(required)_            | OAuth `client_id` registered at the IdP.                                                                                                                                                                                                                                                             |
| `BFF_CLIENT_SECRET`   | _(required)_            | OAuth `client_secret`. **Confidential client** (BCP §6.1.3.1) — server-side only.                                                                                                                                                                                                                    |
| `BFF_API_UPSTREAM`    | _(required)_            | Base URL of the Go API the BFF proxies `/api/*` to.                                                                                                                                                                                                                                                  |
| `BFF_COOKIE_SECRET`   | _(required, ≥32 bytes)_ | HMAC key for the signed double-submit CSRF token (security.md rule 2).                                                                                                                                                                                                                               |
| `BFF_SCOPES`          | `openid profile email`  | Space-delimited OIDC scopes.                                                                                                                                                                                                                                                                         |
| `BFF_AUDIENCE`        | _(optional, unset)_     | Access-token audience. When set, sent as the `audience` param on the authorization request and token/refresh grants so the IdP mints an access token whose `aud` the Go API accepts. **MUST equal the Go API's `OIDC_AUDIENCE`.** Leave unset if the IdP sets the access-token audience server-side. |
| `BFF_DEV_INSECURE`    | _(optional, off)_       | **DEV ONLY.** Set to `true` to allow a **non-loopback** `http://` `BFF_ISSUER_URL`/`BFF_API_UPSTREAM`. By default the BFF fails fast on a plain-http issuer/upstream unless the host is loopback, since those carry the client secret and tokens. Never set in production.                           |
| `BFF_OIDC_TIMEOUT_MS` | `10000`                 | Timeout (ms, integer in `(0, 60000]`) for the BFF's own IdP calls (discovery/token/refresh), so a hung IdP can't pin `/auth/callback` or stall the refresh queue.                                                                                                                                    |
| `BFF_TRUSTED_PROXY`   | _(optional, off)_       | Set to `true` when the BFF runs behind a **trusted** reverse proxy (e.g. Caddy) that sets `X-Forwarded-For`. The BFF then preserves the inbound XFF (appending its peer) so the Go API sees the real client IP. Off = directly-exposed BFF, which trusts only its immediate peer.                    |

### IdP setup checklist

- Register a **confidential** client (it has a `client_secret`).
- Redirect URI: exactly `<BFF_PUBLIC_ORIGIN>/auth/callback`.
- Enable **PKCE (S256)** — the BFF sends it even though it is confidential (RFC 9700
  recommends PKCE for all clients).
- Enable **refresh-token rotation** — the BFF stores the rotated refresh token.
- **No token-endpoint CORS needed** — the code exchange is server-to-server from
  the BFF, never a browser `fetch`.

### CSRF defence in depth

`SameSite=Strict` is necessary but, per OWASP, not sufficient alone. On unsafe
methods the BFF also enforces a **signed double-submit CSRF token**: it sets a
readable `csrf` cookie whose value is `HMAC-SHA256(BFF_COOKIE_SECRET, sessionId)`,
and the SPA echoes it in `X-CSRF-Token`; the BFF recomputes and compares in
constant time. A `Sec-Fetch-Site: cross-site` request is rejected before the CSRF
check. The **ID token is never an API credential** — it is never sent to `/api`.

### Pairing with the Go API

The Go API (`go-api-template`, commit `640994e`) is **unchanged and
pattern-agnostic** — it just validates the bearer the BFF attaches. Make its
`OIDC_ISSUER_URL` / `OIDC_AUDIENCE` match what the IdP mints for this client (set
`BFF_AUDIENCE` to that same `OIDC_AUDIENCE`). In this same-origin BFF topology the
Go CORS middleware can be removed (its own comment says so) — the browser never
calls the Go API cross-origin.

That commit also adds **ABAC cross-user access** on the Go side: an authorised
caller can read another user's rows via `?user=<uuid>`, gated by an OPA policy.
**This SPA does not use that parameter and never sends it.** It is noted only so
you know the capability exists server-side.

**Health check endpoint.** [`src/lib/api/health.ts`](src/lib/api/health.ts) calls
`GET /health`, which the Go API serves publicly ONLY when `PUBLIC_READINESS=true`.
If you keep the SPA health check pointed at `/health`, set `PUBLIC_READINESS=true`
on the Go API. The always-public `/livez` is the alternative endpoint if you would
rather not expose readiness.

**Two user identifiers, never comparable.** `CurrentUser.id` from `/auth/me` is the
RAW IdP `sub`. The Go API's `Log.user_id` is a `UUIDv5(namespace, iss|sub)` derived
from that same subject. They identify the same person but are DIFFERENT strings, so
never compare them for row ownership. Ownership is decided server-side by the Go API
from the bearer, never by the SPA.

> **Lockstep with the Go API:** the BFF resolves the user; the Go API sets the UUID
> via `shared.WithUserID` at the **`r.Route("/api/v1", …)`** block in
> `cmd/api/main.go`, and handlers read it via `shared.UserIDFromContext`. See the
> [`/auth-integration`](.claude/skills/auth-integration/SKILL.md) skill for the
> module map and the production-hardening checklist.

### Standards

[OAuth 2.0 for Browser-Based Apps §6.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps),
[RFC 9700 (OAuth 2.0 Security BCP)](https://www.rfc-editor.org/info/rfc9700),
[RFC 7636 (PKCE)](https://www.rfc-editor.org/info/rfc7636),
[OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html), and the
OWASP [CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html),
[Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html),
and [CSP](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)
cheat sheets.

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
seam. **No retry/refresh logic in the SPA** — the BFF owns token refresh. Add
resources with [`/new-api-resource`](.claude/skills/new-api-resource/SKILL.md).

## Theming

CSS variables in [`app.css`](src/app.css), driven by the preferences store via a
`data-theme` attribute on `<html>`. Light/dark included; no per-component colour
literals.

## Testing

| Layer            | Tooling                                                                 | Covers                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Unit + component | **Vitest Browser Mode** + `vitest-browser-svelte` (Playwright provider) | Real-browser reactivity. `client.ts`, `router.ts`, `health.ts`, `logs.ts`, `Modal.svelte`, `RouteGuard.svelte`, `auth.ts`. |
| BFF              | **Vitest** `node` project (in-process stub IdP/upstream)                | `bff/src/**`: config, sessions, CSRF (HMAC + `Sec-Fetch-Site`), the OIDC flow, and the authenticated proxy. No browser.    |
| API boundary     | **MSW** (Service Worker)                                                | `credentials:'include'`, CSRF header, 401→login, the health + logs resources against mocked endpoints.                     |
| E2E              | **Playwright**                                                          | Routing (deep link, back/forward, 404, SPA fallback) and the **real BFF** against a stub IdP + stub API (`bff` project).   |
| Coverage         | Vitest **v8** with a documented threshold                               | Wired into CI.                                                                                                             |

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

- **Token-free BFF auth** — the BFF (`bff/`) holds all tokens; the browser gets an
  `HttpOnly; Secure; SameSite=Strict`, `__Host-` session cookie; the SPA stores no
  token. **CSRF defence in depth** (signed double-submit `X-CSRF-Token` +
  `Sec-Fetch-Site` gate). **No session material in Web Storage.** **The ID token is
  not an API credential.** The proxy strips inbound credentials and attaches its own.
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

**Serving without Caddy:** the tarball's security posture assumes the bundled
`Caddyfile` sets the response headers. The `<meta>` CSP in `index.html` enforces
most of the policy under any static host, but a `<meta>` tag CANNOT deliver
`frame-ancestors`, `X-Frame-Options`, or `Strict-Transport-Security` (the first is
ignored inside `<meta>` by spec, the other two are HTTP response headers a document
cannot set). A non-Caddy static host therefore MUST send those three headers
itself, or it loses clickjacking and HSTS protection.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every PR and push
to `main`, in three jobs:

- **`pre-commit`** — runs every configured hook (`gitleaks`, `semgrep`, eslint,
  prettier, svelte-check) so the local hooks are mandatory server-side too; they
  are skippable locally via `git commit --no-verify`, not here.
- **`test`** — `eslint` → `prettier --check` → type-check → script tests →
  install chromium → Vitest (with coverage) → `vite build` → **CSP check**
  (`make csp-check` proves `script-src 'self'` in a real browser) → bundle-size
  budget → Playwright E2E. Coverage and the Playwright report upload as artifacts.
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
"Generated with Claude Code" footers. The trailer is disabled via the
`"attribution": { "commit": "", "pr": "" }` setting in
[`.claude/settings.json`](.claude/settings.json) (empty strings hide all
commit/PR attribution); the older `"includeCoAuthoredBy"` key is deprecated in
favour of it.

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

- **Point the shipped BFF at your real IdP and the Go API.** The BFF is
  implemented and E2E-tested against a stub IdP; going live is configuration, not
  code: set the `BFF_*` env, flip `VITE_AUTH_MODE=bff`, register a confidential
  client at your IdP, and work the production-hardening checklist (external session
  store, secret management, absolute session lifetime, a per-IP rate limit on
  `/auth/login`) in
  [`/auth-integration`](.claude/skills/auth-integration/SKILL.md). The Go side
  resolves the user and calls `shared.WithUserID` at the
  [`r.Route("/api/v1", …)`](https://github.com/sud0x0/go-api-template) seam in
  `cmd/api/main.go`; match `OIDC_ISSUER_URL`/`OIDC_AUDIENCE` to what the IdP mints.
- **Confirm the CSP** for any new asset type you introduce (fonts, images, an
  external API origin → extend `connect-src`/`font-src`); re-run `make csp-check`.
- **Tune the bundle-size budget** in `scripts/check-bundle-size.mjs` as the app grows.
