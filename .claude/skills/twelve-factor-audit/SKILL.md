---
name: twelve-factor-audit
description: Audit this Svelte SPA template (or a similar static single-page app) against the 12-Factor App methodology (12factor.net), adapted for a build-and-serve static frontend rather than a long-running server. Use when the user asks "is this 12-factor compliant", "audit against 12factor", "where am I doing 12 factor right/wrong", or wants a per-factor assessment. Walks all 12 factors, assesses the build/serve pipeline (Vite build → tarball → Caddy) for the factors that apply weakly to a static SPA, marks genuinely inapplicable factors "N/A — static SPA" with a reason instead of forcing a verdict, cites specific files as evidence, and produces a verdict table plus actionable improvements.
---

# /twelve-factor-audit — assess against 12factor.net (static-SPA adapted)

The 12-Factor App methodology ([12factor.net](https://12factor.net/)) was written
for long-running services. This repo is a **static single-page app**: `vite build`
emits a bundle, and Caddy serves it as files. Several factors were written about a
server process that a static SPA does not have — so this skill **assesses the
build/serve pipeline** (Vite build, the release tarball, `container.prod` / Caddy)
where a factor applies weakly, and marks a factor **`N/A — static SPA`** with a
one-line reason where it genuinely has no surface, rather than forcing a verdict.

**Applies directly here:** I Codebase · II Dependencies · III Config · V
Build/release/run · VI Processes · X Dev/prod parity.
**Applies weakly (assess the pipeline, or N/A):** IV Backing services · VII Port
binding · VIII Concurrency · IX Disposability · XI Logs · XII Admin processes.

The output is a **summary table** + **per-factor detail with citations** +
**specific improvements**. Every verdict must cite a file path, a grep result, or
a concrete pattern — vibes are not evidence.

## Inputs

None required — the skill audits the current working directory. Ask a clarifying
question only if a pattern is ambiguous.

## Verdict scale

- **Strong** — implements the factor's intent for a static SPA; would pass a purist's audit.
- **Medium-strong** — foundation correct, one recommended extension missing.
- **Medium** — partially follows the factor; one or two clear gaps.
- **Weak** — significant deviation from the factor's intent.
- **Violates** — actively does what the factor says not to.
- **N/A — static SPA** — the factor targets a server process the SPA does not have; state the one-line reason.

## Checks by factor

### 1. Codebase — _applies directly_

Required: one repo, many deploys from the same tree.

| Evidence                                | How                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Single git repo                         | `git rev-parse --show-toplevel` returns one dir                                                               |
| Same tree is the source of every deploy | `.github/workflows/release.yml` builds the tarball from the repo; no forked deploy branches (`git branch -r`) |

### 2. Dependencies — _applies directly_

Required: explicit declaration, no implicit system deps.

| Evidence                           | How                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Lockfile committed + frozen        | `test -f pnpm-lock.yaml`; `grep -rn 'frozen-lockfile' Makefile .github/workflows container.*`                |
| Zero runtime deps (template)       | `package.json` has an empty `dependencies` block — only `devDependencies` ship tooling (security.md rule 10) |
| Tool versions pinned, no `@latest` | `grep -rn '@latest' container.* .github/workflows/*.yml` → nothing; actions SHA-pinned                       |
| Node/pnpm pinned                   | `packageManager` in `package.json`; Node 22 in `container.dev` / CI (decisions.md #12)                       |
| SBOM + vuln scan                   | Syft SBOM in `release.yml`; `make audit` (pnpm audit) in CI + pre-commit                                     |

### 3. Config — _applies directly_

Required: config from the environment, read in one place.

| Evidence                          | How                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Single config seam                | `import.meta.env` read only in `src/lib/config.ts` — `grep -rn 'import.meta.env' src/ \| grep -v config.ts \| grep -v vite-env.d.ts` → nothing (CLAUDE.md, security.md rule 9) |
| Only `VITE_`-prefixed, non-secret | `VITE_AUTH_MODE`, `VITE_API_TARGET`; no secret reaches the bundle (security.md rule 9)                                                                                         |
| Documented                        | `.env.example` documents every variable; `.env` gitignored                                                                                                                     |

Note the build-time nature: Vite inlines `VITE_*` at build. A deploy that needs
different config rebuilds (or templates the Caddy `API_UPSTREAM` at serve time) —
call this out if the audit target expects runtime env swaps of `VITE_*`.

### 4. Backing services — _applies weakly → assess the proxy seam_

The one backing service is the Go API/BFF. It must be an attached resource
referenced by config, swappable without a code change.

| Evidence                             | How                                                                                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API reached by config, not hardcoded | SPA calls only same-origin relative paths (`/api/*`); dev proxies via `VITE_API_TARGET` (`vite.config.ts`), prod reverse-proxies via `API_UPSTREAM` (`Caddyfile`) |
| No hardcoded backend host in source  | `grep -rn 'http://\|https://' src/ \| grep -v localhost` → only comments/docs                                                                                     |

### 5. Build, release, run — _applies directly_

Required: build is reproducible from a commit; release = build + config; run just serves the release.

| Evidence                     | How                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| Reproducible build           | `pnpm build` from the pinned lockfile; CSP-satisfying build options in `vite.config.ts` (decisions.md #4) |
| Immutable, versioned release | `release.yml` produces a version-named tarball + SBOM + SHA-256 checksums + SLSA L3 provenance            |
| Run = serve the artifact     | `container.prod` / `Caddyfile` serve the built `dist/` as static files; no build step at run time         |
| One source of version truth  | Version from `package.json` (`make` reads it; the tag drives the release)                                 |

### 6. Processes — _applies directly_

Required: stateless, share-nothing. For an SPA: no server-side session, state in memory only.

| Evidence                        | How                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| No session material in storage  | `grep -rnE 'localStorage\|sessionStorage' src/` → only `preferences.svelte.ts` (security.md rule 3)                    |
| Auth state in memory only       | `src/lib/stores/auth.svelte.ts` holds only `CurrentUser`, never persisted; the session is a cookie the SPA never reads |
| Static assets are share-nothing | The served bundle is immutable files — any instance/CDN edge serves them identically                                   |

### 7. Port binding — _applies weakly → assess the serve layer_

A static bundle exports files, not a self-contained server. The serving layer is
Caddy (prod) / Vite (dev).

| Evidence                     | How                                                                         |
| ---------------------------- | --------------------------------------------------------------------------- |
| Dev server binds a port      | Vite on `:3000` (`compose.dev.yaml`, `vite.config.ts`)                      |
| Prod serve is self-contained | Caddy binds `:80`/`:443` and serves `dist/` (`Caddyfile`, `container.prod`) |

Verdict is usually `N/A — static SPA` for the strict reading (the app is files,
not a bound process); note the Caddy/Vite serve layer instead of forcing it.

### 8. Concurrency — _applies weakly_

Static assets scale horizontally for free — any number of Caddy instances or a CDN
serve the same immutable files; there is no per-process state to coordinate. Assess
whether anything defeats that (e.g. server-affinity assumptions). Usually
`Strong` by nature or `N/A — static SPA`; say which and why.

### 9. Disposability — _applies weakly → assess the serve container_

No app process to start/stop gracefully. Assess the **dev/serve container**: fast,
reproducible startup (`container.dev` / `container.prod`), no long warm-up. The
build is the slow step and happens ahead of serve, not at request time. Usually
`N/A — static SPA` for the graceful-shutdown reading.

### 10. Dev/prod parity — _applies directly_

Required: same code paths, same tooling, same config names in dev and prod.

| Evidence                         | How                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Same bundle dev-builds and ships | `vite build` output is what CI builds and the tarball ships; E2E runs against `vite preview` of the real build |
| Same config names                | `.env.example`, compose env, and `Caddyfile` env use the same `VITE_*` / `API_UPSTREAM` names                  |
| No dev-only code paths           | `grep -rn "import.meta.env.DEV\|NODE_ENV" src/` → none gating security-relevant behaviour                      |
| Same Node pin                    | `container.dev` and CI both pin Node 22 (decisions.md #12)                                                     |

### 11. Logs — _applies weakly_

A browser SPA has no server log stream of its own; request logs belong to the Caddy
edge and the API. Assess that the SPA does not try to own logging (no bundled
log-shipping, no file writes — impossible in a browser anyway). Usually
`N/A — static SPA`, with the note that access logging is Caddy's/edge's job.

### 12. Admin processes — _applies weakly_

No runtime admin tasks against a live process. The equivalent one-off tasks are
repo scripts run from the same tree: `scripts/extract-changelog.sh`,
`make changelog-check`, `make prod-bundle`. Confirm they live in-repo and share the
same config/versioning. Usually `N/A — static SPA` for the running-process reading;
note the release/changelog scripts as the in-repo equivalent.

## Output format

Produce **two sections**:

### 1. Summary table

```
| #  | Factor              | Verdict            |
|----|---------------------|--------------------|
| 1  | Codebase            | Strong             |
| 2  | Dependencies        | Strong             |
| 7  | Port binding        | N/A — static SPA   |
| ...
```

### 2. Per-factor detail

For each factor, a short paragraph: what you found (cite file paths + grep
results), why it earns its verdict (the specific 12-factor criterion or the
reason it's `N/A — static SPA`), and — if not Strong — what would close the gap.
~60–120 words each; tighter for Strong / N/A.

End with a `TL;DR` count (how many Strong, Medium, Weak/Violating, N/A) and note
any deliberate trade-offs the repo documents (e.g. build-time `VITE_*` config;
auth intentionally a seam — `decisions.md` #1).

## Non-negotiables

- **Cite evidence.** Every verdict needs at least one file path, grep result, or
  pattern citation.
- **Distinguish "not a server" from "wrong".** A static SPA legitimately has no
  bound process, no graceful shutdown, no server logs — mark those
  `N/A — static SPA` with a reason; do not score them as failures.
- **Assess the pipeline where the factor applies weakly** (build/serve/tarball/
  Caddy) rather than skipping it — the weak-fit factors still have real surface.
- **Don't recommend over-engineering.** Don't invent a server, a worker, or
  runtime config injection the template doesn't need.
