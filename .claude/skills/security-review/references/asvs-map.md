# ASVS 5.0.0 applicability map — svelte-ui-template

**Verification bar: Level 2** (all L1 requirements are included by definition;
L3-only requirements are out of scope). Standard: **OWASP ASVS 5.0.0**
(May 2025), committed under [`references/`](.) as
[`asvs-5.0.0.txt`](asvs-5.0.0.txt).

> Contains material from the OWASP Application Security Verification Standard
> 5.0.0, © 2008–2025 The OWASP Foundation, licensed CC BY-SA 4.0
> (<https://owasp.org/www-project-application-security-verification-standard/>).
> Requirements below are **paraphrased**, not reproduced. See
> [`ATTRIBUTION.md`](ATTRIBUTION.md).

This is a **browser SPA**, not a server. The chapters that carry weight here are
the client-side ones — **V1** (output encoding), **V2** (validation boundary),
**V3** (Web Frontend Security: CSP, security headers, cookies, CSRF), and
**V14** (data protection / browser storage). The token-owning half of the model
lives in the future Go BFF, so the authentication/session/token chapters
(**V6/V7/V9/V10**) are _deferred with auth_ — only the seam ships
([`decisions.md` #1/#2](../../../rules/decisions.md)).

**Maintenance rule (this map is a working document, not a snapshot):** any change
that touches a mapped area **updates its rows AND their test evidence in the same
change**. A stale row is a bug — the same class of defect as a stale comment.
**A `met` row without a value in the Test evidence column is invalid**: a `met`
status is a claim, and an unverified claim can silently regress, so a `met`
control with no test naming it is demoted to `met-untested` and listed under
Gaps. When the BFF is wired up (`VITE_AUTH_MODE=bff`), chapters V6/V7/V9/V10 move
from _deferred_ to per-requirement rows in the same change (see
[`decisions.md` #1](../../../rules/decisions.md) and the `/auth-integration` skill).

**Status vocabulary:** `met` (a template control satisfies it, cited, **with a
named test / `make csp-check` in the Test evidence column**) · `met-untested`
(met in code but no automated check proves it — a finding) · `partial`
(satisfied outside the SPA, e.g. at the Caddy edge or in the future BFF, or only
in part; note who owns the rest) · `gap` (not satisfied; a finding) · `n/a` (no
surface in a static SPA; reason given) · `deferred with auth` (V6/V7/V8/V9/V10 —
applicable only once the BFF lands, [`decisions.md` #1/#2](../../../rules/decisions.md)).
Row IDs use the standard's own reference form (chapter `V<n>`, requirement
`<n>.<section>.<index>`).

The **write-time rule set** is [`.claude/rules/security.md`](../../../rules/security.md)
(the ten rules); the ASVS IDs are WHAT those rules satisfy.

---

## V1 Encoding and Sanitization

| ID    | Requirement (paraphrased)                                         | L   | Status | Control / file                                                                                                                    | Test evidence                                  |
| ----- | ----------------------------------------------------------------- | --- | ------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1.2.1 | Context-correct output encoding for the HTTP/HTML/CSS context     | 1   | met    | Svelte escapes all interpolated values by default; no `{@html}` on dynamic data (security.md rule 5)                              | `make csp-check` + code review (grep `{@html`) |
| 1.2.3 | Encode/escape when building JS/JSON to prevent injection          | 1   | met    | No `eval`/`new Function`; API JSON is parsed, never `innerHTML`-injected; the client returns typed data (`src/lib/api/client.ts`) | `client.test.ts`                               |
| 1.3.x | Sanitize before a dangerous sink; no raw HTML from untrusted data | 1–2 | met    | Rule 5: render as text, let Svelte escape; `{@html}` forbidden on user/API data                                                   | code review (grep `{@html`)                    |

## V2 Validation and Business Logic

| ID    | Requirement (paraphrased)                                                | L   | Status  | Control / file                                                                                                                                                                       | Test evidence                     |
| ----- | ------------------------------------------------------------------------ | --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| 2.2.1 | Validate input against expected structure/allowlist                      | 1   | met     | Untrusted API JSON narrowed at the boundary before it reaches a component — `assertHealthResponse` / `assertCurrentUser` / `isApiError` (`src/lib/types/api.ts`, security.md rule 8) | `types.test.ts`, `health.test.ts` |
| 2.2.2 | Enforce validation at a trusted layer; client checks are not the control | 1   | partial | The SPA validates API responses at its boundary, but authoritative input validation is the server's/BFF's job — the SPA's checks are defensive parsing, not the security control     | `types.test.ts`                   |

## V3 Web Frontend Security

The core chapter for this repo. Header controls live in the
[`Caddyfile`](../../../Caddyfile) (authoritative, incl. `frame-ancestors`) and,
for `vite preview`, the `<meta>` CSP in [`index.html`](../../../index.html).

| ID    | Requirement (paraphrased)                                                              | L   | Status  | Control / file                                                                                                                                                                                                                                      | Test evidence                  |
| ----- | -------------------------------------------------------------------------------------- | --- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 3.2.2 | Text (not HTML) rendered via safe functions (`textContent`), not HTML injection        | 1   | met     | Svelte binds text as text nodes; no `{@html}` on dynamic data (security.md rule 5)                                                                                                                                                                  | code review (grep `{@html`)    |
| 3.3.1 | Cookies set `Secure`; `__Host-`/`__Secure-` name prefix                                | 1   | partial | Session cookie is `__Host-`-prefixed + `Secure` **by contract** (security.md rule 1); set by the BFF, not the SPA — verified once auth lands                                                                                                        | — (BFF-owned)                  |
| 3.3.2 | Cookie `SameSite` set to limit CSRF                                                    | 2   | partial | `SameSite=Strict` by contract (security.md rule 1, decisions.md #3); BFF-set                                                                                                                                                                        | — (BFF-owned)                  |
| 3.3.3 | `__Host-` prefix unless deliberately host-shared                                       | 2   | partial | `__Host-` session cookie by contract (security.md rule 1); BFF-set                                                                                                                                                                                  | — (BFF-owned)                  |
| 3.3.4 | Session cookie is `HttpOnly`; value only via `Set-Cookie`                              | 2   | partial | `HttpOnly` by contract — the SPA never reads or stores the session (security.md rules 1, 3); BFF-set                                                                                                                                                | — (BFF-owned)                  |
| 3.4.1 | `Strict-Transport-Security` on all responses, `max-age ≥ 1yr` (+subdomains for L2)     | 1   | met     | `Strict-Transport-Security "max-age=63072000; includeSubDomains"` — `preload` left off as an operator opt-in (`Caddyfile`, security.md rule 7)                                                                                                      | code review (`Caddyfile`)      |
| 3.4.2 | CORS `Access-Control-Allow-Origin` fixed/allowlisted; no sensitive data under `*`      | 1   | met     | Same-origin model — SPA + API behind Caddy, no CORS headers emitted, no cross-origin surface (decisions.md #5, security.md "Same-origin model")                                                                                                     | code review (`Caddyfile`)      |
| 3.4.3 | Global CSP incl. `object-src 'none'` + `base-uri`, with allowlist/nonces/hashes        | 2   | met     | `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'` (`Caddyfile`). Documented deviations: `base-uri 'self'` (not `'none'`) and `style-src 'unsafe-inline'` for Vite's runtime CSS (decisions.md #4) | `make csp-check`               |
| 3.4.4 | `X-Content-Type-Options: nosniff` on all responses                                     | 2   | met     | `X-Content-Type-Options "nosniff"` (`Caddyfile`, security.md rule 7)                                                                                                                                                                                | code review (`Caddyfile`)      |
| 3.4.5 | Referrer-Policy set to prevent `Referer` leakage                                       | 2   | met     | `Referrer-Policy "strict-origin-when-cross-origin"` (`Caddyfile`)                                                                                                                                                                                   | code review (`Caddyfile`)      |
| 3.4.6 | CSP `frame-ancestors` on every response (XFO obsolete)                                 | 2   | met     | `frame-ancestors 'none'` in the CSP **plus** `X-Frame-Options: DENY` belt-and-braces (`Caddyfile`, security.md rule 7)                                                                                                                              | `make csp-check` + code review |
| 3.5.1 | Anti-forgery on state-changing requests (token / non-safelisted header)                | 1   | met     | Client attaches a double-submit `X-CSRF-Token` header on unsafe methods (`src/lib/api/client.ts`, security.md rule 2, decisions.md #3); BFF validates it — validation half deferred with auth                                                       | `client.test.ts`               |
| 3.5.3 | Sensitive functionality uses unsafe HTTP methods (not GET), or validates `Sec-Fetch-*` | 1   | met     | The client attaches CSRF only on `POST/PUT/PATCH/DELETE`; safe methods carry no state change (`src/lib/api/client.ts`)                                                                                                                              | `client.test.ts`               |
| 3.6.1 | External client-side assets versioned + SRI, or a documented decision                  | 3   | n/a     | No external assets — the strict CSP forbids third-party origins; all JS/CSS is self-hosted, fingerprinted, no CDN (decisions.md #4)                                                                                                                 | `make csp-check`               |

## V14 Data Protection

| ID     | Requirement (paraphrased)                                                         | L   | Status | Control / file                                                                                                                                                                                                                                        | Test evidence                         |
| ------ | --------------------------------------------------------------------------------- | --- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 14.2.1 | Sensitive data only in body/headers; never in URL/query (no token/API key in URL) | 1   | met    | No tokens anywhere in the SPA; the ID token is never received or sent (security.md rules 1, 4); requests carry a cookie the SPA never reads                                                                                                           | `client.test.ts`                      |
| 14.3.2 | Anti-caching headers (`Cache-Control: no-store`) on sensitive responses           | 2   | met    | SPA shell served `no-store, no-cache, must-revalidate`; only fingerprinted assets are cached immutably (`Caddyfile`)                                                                                                                                  | code review (`Caddyfile`)             |
| 14.3.3 | Browser storage holds no sensitive data (session tokens excepted)                 | 2   | met    | No tokens/session in `localStorage`/`sessionStorage`; the auth store holds only the non-sensitive `CurrentUser` in memory; `localStorage` is prefs-only (security.md rule 3, `src/lib/stores/auth.svelte.ts`, `src/lib/stores/preferences.svelte.ts`) | `auth.test.ts`, `preferences.test.ts` |

## V15 Secure Coding and Architecture

| ID     | Requirement (paraphrased)                                      | L   | Status       | Control / file                                                                                                                                                                                            | Test evidence                  |
| ------ | -------------------------------------------------------------- | --- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 13.3.1 | Secrets never in source or build artifacts; managed externally | 2   | met          | Only `VITE_`-prefixed non-secret config reaches the bundle; `.env` gitignored; the future OIDC client secret lives only in the BFF; gitleaks in pre-commit + CI (security.md rule 9, `src/lib/config.ts`) | `make semgrep` + gitleaks hook |
| 15.1.2 | Maintain an SBOM from trusted, maintained sources              | 2   | met-untested | Release pipeline emits a Syft SPDX-JSON SBOM + checksums; zero runtime deps (`.github/workflows/release.yml`)                                                                                             | **none (pipeline-produced)**   |

## V16 Security Logging and Error Handling

| ID     | Requirement (paraphrased)                                         | L   | Status | Control / file                                                                                                                                                               | Test evidence                                                    |
| ------ | ----------------------------------------------------------------- | --- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 16.5.1 | Generic error to the user; no stack traces/queries/secrets leaked | 2   | met    | API errors narrowed to a typed shape via `parseApiError` / `isApiError`; the SPA surfaces a message, never raw internals (`src/lib/utils/errors.ts`, `src/lib/types/api.ts`) | `errors.test.ts`                                                 |
| 16.5.3 | Fail gracefully and securely; no fail-open                        | 2   | met    | The client owns the 401→`login(returnTo)` seam and route guards fail closed (block, not fall through) (`src/lib/api/client.ts`, `src/lib/components/auth/RouteGuard.svelte`) | `client.test.ts`, `RouteGuard.test.ts`, `RouteGuard.bff.test.ts` |

---

## Chapter-level (no per-requirement rows)

| Chapter                  | Assessment         | Reason                                                                                                                                                                                             |
| ------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V5 File Handling         | n/a                | The SPA has no file-upload surface; becomes applicable if an adopter adds one.                                                                                                                     |
| V6 Authentication        | deferred with auth | Authentication is intentionally not implemented — only the token-free seam ships (`decisions.md` #1/#2). The OIDC flow lives in the BFF; expand to per-requirement rows when `VITE_AUTH_MODE=bff`. |
| V7 Session Management    | deferred with auth | The session is an `HttpOnly` cookie owned by the BFF; the SPA stores/reads no session (`decisions.md` #1, security.md rule 1). Expand when auth lands.                                             |
| V8 Authorization         | deferred with auth | `RouteGuard` is a UX gate only; real authorization is enforced server-side by the BFF/API. The SPA must never be the authorization control. Expand when auth lands.                                |
| V9 Self-contained Tokens | deferred with auth | The SPA issues/parses no tokens (no JWT in memory or storage) — the BFF holds them (`decisions.md` #2). Expand when auth lands.                                                                    |
| V10 OAuth and OIDC       | deferred with auth | OAuth/OIDC (Authorization Code + PKCE) is exactly what the BFF owns; the browser-based-OAuth-client alternative is the recorded weaker fallback (`decisions.md` #2). Expand when auth lands.       |
| V11 Cryptography         | n/a                | No application-level cryptography in the SPA; TLS is Caddy's, tokens/keys are the BFF's.                                                                                                           |
| V12 Secure Communication | partial (edge)     | TLS is terminated by Caddy (TLS 1.2/1.3, HSTS with `includeSubDomains`; `preload` is an operator opt-in); the SPA serves only same-origin relative paths (`Caddyfile`, `decisions.md` #5/#10).     |
| V17 WebRTC               | n/a                | No real-time/WebRTC media surface.                                                                                                                                                                 |

---

## Gaps (findings)

Every `partial`, `met-untested`, and `gap` row is a finding for the owner to
schedule. In this template none are code defects — they are either **BFF-owned**
(the cookie/session/auth rows, which activate with `/auth-integration`) or
**pipeline/edge-owned**.

### met-untested (met, but no automated check names it)

| ID     | Area | Behaviour with no test                                                        |
| ------ | ---- | ----------------------------------------------------------------------------- |
| 15.1.2 | V15  | SBOM is produced by the release pipeline (Syft), not asserted by a unit test. |

### partial (satisfied at the edge / in the future BFF — verify per deployment)

| ID          | Area | Note                                                                                                                                               |
| ----------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.2.2       | V2   | Authoritative input validation is the server's; the SPA's boundary guards are defensive parsing.                                                   |
| 3.3.1–3.3.4 | V3   | Session-cookie attributes (`__Host-`, `Secure`, `SameSite=Strict`, `HttpOnly`) are a **contract** the BFF sets — inert until `VITE_AUTH_MODE=bff`. |
| 3.5.1       | V3   | The SPA attaches the `X-CSRF-Token` double-submit header; the BFF must validate it (validation half deferred).                                     |
| 12.1.x      | V12  | TLS terminated at the Caddy edge, not in the SPA.                                                                                                  |
