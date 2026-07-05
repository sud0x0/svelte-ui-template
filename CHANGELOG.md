# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Release notes for tagged versions are the body of the matching `## [X.Y.Z]`
section, extracted by [`scripts/extract-changelog.sh`](scripts/extract-changelog.sh)
and used as the GitHub Release body — the release workflow **fails** if the
section is missing or empty. **Commit messages do not feed the changelog.** Keep
`## [Unreleased]` current as you ship; before tagging, move it to a dated
`## [X.Y.Z]` section and run `make changelog-check VERSION=x.y.z`.

## [Unreleased]

The 0.1.0 baseline — a production-ready Svelte 5 (runes) SPA template, the
front-end counterpart to [go-api-template](https://github.com/sud0x0/go-api-template).
Stack, tooling, test harness, and a token-free auth seam — not features.

### Added

- Layered architecture, one concern per module: routes orchestrate, `lib/api/*`
  owns all network I/O through a single client, `lib/stores/*` owns state,
  `lib/components/*` are reusable, `lib/utils/*` are pure. No route imports `fetch`.
- Runes-first state in `.svelte.ts` modules with plain accessors (not the legacy
  `writable` store API); auth state is in-memory only, preferences persist through
  a thin typed wrapper.
- A hand-rolled History-API router (`lib/stores/router.svelte.ts`): URL-driven,
  typed route params, back/forward via popstate, a 404 fallback, and route-level
  code splitting via dynamic `import()`.
- A top-level `<svelte:boundary>` error boundary around the router outlet; theming
  via CSS variables in `app.css`; single-source-of-truth config in `lib/config.ts`.
- Auth seam (OIDC/BFF-ready, NOT implemented) — the contract only:
  `VITE_AUTH_MODE` (`disabled` | `bff`), `auth.ts` stubs with `// TODO(auth)`
  markers, the in-memory `CurrentUser` store, `RouteGuard` with `returnTo`
  capture, and the single API client's three seam hooks: `credentials: 'include'`,
  the `X-CSRF-Token` double-submit header on unsafe methods, and the centralised
  401→`login(returnTo)` path. No tokens (access/refresh/ID) are stored or parsed
  anywhere in `src/`; the intended BFF flow, the four future `/auth/*` endpoints,
  and the cookie/CSRF/ID-token rules are documented in the README's
  "Authentication" section.
- Reference feature: `GET /health` surfaced on the guarded Home view via a load
  function + `{#await}` (not `$effect`), plus the auth-disabled seam demo (dev
  user, no-op logout, Modal) — the only feature, proving the stack, the harness,
  and the seam.
- Test harness: Vitest Browser Mode (`vitest-browser-svelte` + Playwright
  provider) for unit + component tests; MSW for the API boundary; Playwright for
  E2E (routing, SPA fallback, and the auth-redirect seam); v8 coverage with a
  documented threshold. Example tests for `client.ts` (CSRF header + 401
  returnTo), `router.ts`, `health.ts`, `Modal.svelte`, `RouteGuard.svelte`, and
  `auth.ts`.
- Tooling: `make ci` / `make verify` verification loop (lint + format + types +
  unit + build + bundle-size, then E2E); pnpm + Node 22 dev container (podman);
  ESLint flat config, Prettier, svelte-check; pre-commit suite; CI + SLSA L3
  release pipeline with a Syft SPDX-JSON SBOM and a Caddyfile-bundled tarball.
- `.claude/` system: `CLAUDE.md`, `rules/security.md`, `rules/decisions.md`
  (seeded trade-offs), and eleven skills — `new-component`, `new-route`,
  `new-api-resource`, `auth-integration`, `security-review`,
  `architecture-review`, `performance-review`, `write-unit-tests`,
  `write-comments`, `write-readme`, and `twelve-factor-audit` — plus a
  durable-command allow-list in `settings.json`.
- `make audit` dependency-vulnerability gate (`pnpm audit --prod --audit-level
  high`), wired into a `pnpm-audit` pre-commit hook (scoped to `pnpm-lock.yaml`)
  and an "Audit dependencies" CI step.
- `security-review` reference set: the OWASP ASVS 5.0.0 standard rendered to
  `references/asvs-5.0.0.txt`, a front-end applicability map (`references/asvs-map.md`)
  mapping the SPA-relevant chapters to this repo's controls, and `ATTRIBUTION.md`.
- `check-merge-conflict` pre-commit hook.

### Changed

- Every GitHub Action in `ci.yml` and `release.yml` moved from mutable tags to
  SHA-pinned refs (tag kept as a trailing comment); the SLSA reusable workflow is
  the one documented exception (must be called by tag).
- semgrep moved off `--config=auto` to pinned rulesets (`p/typescript`,
  `p/javascript`, `p/github-actions`, plus the mutable-action-tag and
  curl-pipe-shell supply-chain rules) in both the Makefile and pre-commit, and
  aligned to `1.165.0`.
- `settings.json` attribution mechanism switched from the no-longer-documented
  `includeCoAuthoredBy` to `attribution: { commit: "", pr: "" }`, and hardened
  with a deny list (`git commit`/`tag`/`push` and edits to `settings*.json`).
- The never-commit rule is now documented in `CLAUDE.md` as the first
  always-apply rule, and `decisions.md` #14 records the deliberate coverage-gate
  divergence from go-api-template.
- Makefile sections realigned with go-api-template (First-time setup →
  Development → Release → Testing → Code quality → Help); the security scanners
  fold into Code quality.
- The `.gitleaks.toml` `.claude/` note expanded to a machine-written-directory
  policy; this CHANGELOG regrouped into the Keep a Changelog taxonomy.

### Security

- Front-end security rules in [`.claude/rules/security.md`](.claude/rules/security.md):
  token-free BFF seam, CSRF defence in depth, no session material in Web Storage,
  ID-token-is-not-an-API-credential, no raw `{@html}`, a CSP the bundle actually
  satisfies (`script-src 'self'`, verified in CI), edge security headers, boundary
  validation, no secrets in the bundle.
- A strict CSP achieved without a plugin (no inline scripts: `modulePreload.polyfill`
  off, `assetsInlineLimit: 0`), proven by `make csp-check`. Full edge header set in
  the `Caddyfile`. gitleaks + semgrep in pre-commit and CI.
- Supply-chain hardening this round: SHA-pinned GitHub Actions enforced by the
  semgrep `github-actions-mutable-action-tag` and `gha-curl-pipe-shell` rules; the
  `make audit` / `pnpm-audit` dependency-vulnerability gate; and a `settings.json`
  deny list that blocks agent commits and self-edits of the permissions file.

<!-- Add entries here as you ship changes. Keep a Changelog groups, in order: Added, Changed, Deprecated, Removed, Fixed, Security — omit any that stay empty. On the first release, retitle this `## [Unreleased]` heading to `## [X.Y.Z] - <date>` and run `make changelog-check VERSION=x.y.z`: scripts/extract-changelog.sh extracts the matching `## [X.Y.Z]` section as the GitHub Release body (the release workflow fails on a missing/empty section), and tagging is the repository owner's act — agents never tag. -->
