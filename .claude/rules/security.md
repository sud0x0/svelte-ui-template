# Front-end security rules

Non-negotiable. Read before touching `lib/api/`, `client.ts`, `auth.ts`, the
guards, the router, or the `Caddyfile`. These are the source of truth; the
README's "Security model" is the abbreviated human version.

## The hierarchy (OWASP)

> Validate untrusted data at the boundary, never trust the client, and encode on
> output — at each language boundary, using the tool that owns that boundary.

In a browser SPA the boundaries are: JSON coming back from the API (validate at
`lib/types/api.ts` guards before it reaches a component), values rendered into
the DOM (let Svelte escape them — never `{@html}` on dynamic data), and the
session credential (a cookie the SPA never reads, never stores). The reference
modules under `lib/` implement every rule below — copy them.

## The rules

1. **Auth is a token-free BFF — implemented, not just a seam.** The reference
   BFF (`bff/`) is the confidential OIDC client and it is the top-ranked
   architecture of the IESG-approved
   [draft-ietf-oauth-browser-based-apps](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps)
   BCP (§6.1). **Tokens live in the BFF, never in the browser.** The BFF performs
   Authorization Code + PKCE, holds all access/refresh/ID tokens server-side, and
   the browser gets an `HttpOnly; Secure; SameSite=Strict`, `__Host-`-prefixed
   session cookie only. The SPA stores/parses **no** access, refresh, or ID token
   (`src/lib/stores/auth.svelte.ts` holds just the `CurrentUser` profile). In
   `disabled` mode the seam is inert (static dev user); in `bff` mode the whole
   flow is live and end-to-end tested (`tests/e2e/bff.spec.ts`). The BFF MUST be a
   confidential client using the Authorization Code grant (BCP §6.1.3.1, RFC 9700
   §2.1.1). The browser-based OAuth-client alternative (tokens in memory, PKCE in
   `sessionStorage`) is a recorded _weaker_ fallback in
   [decisions.md](./decisions.md), not the design shipped. Cite
   [RFC 9700](https://www.rfc-editor.org/info/rfc9700).

   **`return_to` is an open-redirect sink — the BFF validates it.** The SPA passes
   `?return_to=` through opaquely (it captures `location.pathname +
location.search` and cannot be trusted to sanitise it), so the BFF's
   `/auth/login` accepts `return_to` **only** as a same-site relative path: it
   MUST start with a single `/` and is rejected if it starts with `//` or `/\`
   (protocol-relative), contains a backslash, or carries any scheme or authority
   (`https:`, `javascript:`, `user@host`, …), falling back to `/`. The raw-string
   guards are **not sufficient alone**: WHATWG URL normalisation collapses
   dot-segments, so `/..//evil.com` (and the `/a/..//`, `/./..//`, `/%2e%2e//`
   family) parses to pathname `//evil.com` — a protocol-relative target. So
   `validateReturnTo` ALSO rejects a **normalised** pathname that starts with `//`,
   and `/auth/callback` emits the redirect as an **absolute same-origin URL**
   (`publicOrigin + returnTo`, string-concatenated — never `new URL(returnTo,
   publicOrigin)`, which would re-resolve `//host` to a cross-origin URL) so a
   stray `//path` can never be reinterpreted as protocol-relative. Implemented and
   tested in `bff/src/routes/auth.ts` (`validateReturnTo`), including the
   dot-segment/encoded family and an end-to-end browser test in
   `tests/e2e/bff.spec.ts`. An unvalidated redirect target is an open redirect
   ([OWASP Unvalidated Redirects & Forwards](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html)).
   **The BFF is the single validation owner. Do NOT duplicate the validator on the
   SPA side** (the SPA cannot be trusted for this check, and a second copy invites
   drift where one side is tightened and the other is not). The SPA comment at the
   `login()` call site records this deliberately.
   See [auth-integration](../skills/auth-integration/SKILL.md).

2. **CSRF defence in depth for the cookie session.** `SameSite=Strict` is
   necessary but, per the [OWASP CSRF Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
   ("should not be the sole defence") and [MDN](https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/CSRF_prevention)
   ("not a complete defense"), it must not be the only control. State-changing
   requests (`POST/PUT/PATCH/DELETE`) carry an additional control — a
   double-submit `X-CSRF-Token` header. **The `csrf` cookie value the BFF sets is
   a session-bound HMAC token — the _signed_ double-submit pattern, not a bare
   random value** (`bff/src/csrf.ts`: `HMAC-SHA256(BFF_COOKIE_SECRET, sessionId)`,
   verified server-side with a constant-time compare). The naive double-submit
   cookie is forgeable via cookie injection from a sibling subdomain or a MITM, so
   the OWASP CSRF Cheat Sheet says to "always prefer the Signed Double-Submit
   Cookie pattern with session-bound HMAC tokens". **Fetch-Metadata gate:** an
   unsafe request the browser labels `Sec-Fetch-Site: cross-site` is rejected
   BEFORE the CSRF check (defence in depth; absent header ⇒ no decision).

   **Cookie attribute contract (BCP §6.1.3.2).** The `__Host-session` (and the
   short-lived `__Host-txn`) cookies are `Secure`, `HttpOnly`, `SameSite=Strict`,
   `Path=/`, with **no** `Domain` and the `__Host-` prefix (the browser rejects a
   `__Host-` cookie that is not Secure / not Path=/ / has a Domain, so a sibling
   subdomain cannot set or overwrite it). The readable `csrf` cookie is `Secure` +
   `SameSite=Strict` but **not** `HttpOnly` (the SPA must echo it) — being readable
   is harmless because its value is an HMAC. Browsers accept `Secure` cookies on
   `http://localhost`, so local dev over plain HTTP still works.

   **The SPA is unchanged by any of this:** `src/lib/api/client.ts` just echoes
   whatever `csrf` cookie the BFF set back in the `X-CSRF-Token` header on unsafe
   methods — it neither mints nor validates the token (header names are
   case-insensitive, so the BFF's `x-csrf-token` and the client's `X-CSRF-Token`
   are the same header).

3. **Never put session material in Web Storage.** No tokens or session
   identifiers in `localStorage`/`sessionStorage` ([OWASP HTML5 Storage](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html)).
   `lib/stores/auth.svelte.ts` holds only the non-sensitive `CurrentUser`
   profile, in memory. `localStorage` is used **only** for non-sensitive
   preferences (`lib/stores/preferences.svelte.ts`).

4. **The ID token is not an API credential.** No SPA code path ever receives or
   sends an ID token to `/api`. ([Auth0: ID token vs access token](https://auth0.com/blog/id-token-access-token-what-is-the-difference/).)
   The BFF exchanges and validates the ID token server-side; the browser only
   ever sees the session cookie.

5. **Output encoding / no raw HTML.** Never `{@html …}` on user- or API-derived
   data. If genuinely unavoidable, sanitise at that boundary with a justifying
   comment. Default: render as text and let Svelte escape.

6. **CSP the built bundle actually satisfies.** Target `default-src 'self'`,
   `script-src 'self'` (no `unsafe-inline`, no `unsafe-eval`), `connect-src
'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`.
   Because a static SPA has no server to mint per-request nonces, script
   strictness is achieved by emitting **no inline scripts**: `vite.config.ts`
   sets `build.modulePreload.polyfill = false` and `build.assetsInlineLimit = 0`,
   so the bundle has only external `'self'` scripts and no `data:` scripts. The
   documented compromise is `style-src 'self' 'unsafe-inline'` (Vite injects
   code-split CSS via runtime `<style>` elements; style injection is lower risk
   than script) — recorded in [decisions.md](./decisions.md). The policy lives in
   the `Caddyfile` (authoritative, incl. `frame-ancestors`) and in a `<meta>` tag
   in `index.html` (so it is enforced under `vite preview` too). **Verification is
   mandatory:** `make csp-check` loads the built bundle and fails on any CSP
   violation. Cite the [MDN CSP guide](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP).

7. **Security headers at the edge.** The `Caddyfile` sets HSTS (long `max-age` +
   `includeSubDomains`, HTTPS-only; `preload` is deliberately NOT set — it is a
   hard-to-reverse operator opt-in that requires submission to the browser
   preload list, so the domain owner appends it, not the template),
   `X-Content-Type-Options: nosniff`, CSP with
   `frame-ancestors 'none'` **plus** `X-Frame-Options: DENY`, `Referrer-Policy:
strict-origin-when-cross-origin`, `Permissions-Policy` locking
   geolocation/microphone/camera, `Cross-Origin-Opener-Policy: same-origin`, and
   `-Server`.

8. **Validate API responses at the boundary.** The types in `lib/types/api.ts`
   are the contract; the client narrows/guards untrusted JSON (`assertHealthResponse`,
   `assertCurrentUser`, `assertListLogsResponse`, `isApiError`) before it reaches
   components. The BFF, in turn, validates the ID token (signature via JWKS, `iss`,
   `aud`, `exp`, `nonce`) with `openid-client` before trusting any claim.

9. **No secrets in the bundle.** Only `VITE_`-prefixed, non-secret config reaches
   the client. The OIDC **client secret** and the **CSRF cookie secret** live only
   in the BFF process (`bff/src/config.ts`, from the non-`VITE_` `BFF_*` env) —
   never in the browser bundle. `.env` is git-ignored; `.env.example` documents
   every variable. gitleaks runs in pre-commit and CI (and scans `.claude/`).

10. **Dependencies are a supply-chain decision.** Any new runtime dependency is
    justified in the commit body. SBOM (Syft) + `make socket` (Socket.dev) back
    this up. The **browser bundle** ships with **zero** runtime dependencies — keep
    it lean. The **BFF** admits exactly one, audited: `openid-client` (an IESG-BCP
    recommendation is not a licence to hand-roll OAuth). See
    [decisions.md](./decisions.md).

11. **The proxy strips inbound credentials and attaches its own.** In `bff` mode
    the BFF proxies `/api/*` to the Go API (`bff/src/proxy.ts`). It **strips the
    inbound `Authorization` and `Cookie` headers** from the browser's request and
    attaches `Authorization: Bearer <access token>` from the server-side session —
    so the browser can never smuggle its own credential past the BFF, and the ONLY
    bearer the API sees is the one the BFF controls. Response status passes through
    untouched (a `403` stays a `403`; only `401` drives re-login). The request
    logger records method/path/status/duration only — **never headers, cookies, or
    tokens**.

## Same-origin model

SPA and backend are same-origin behind Caddy, which reverse-proxies `/api/*`,
`/auth/*`, and `/health`. In `disabled` mode the backend is the Go API directly;
in `bff` mode it is the BFF (which is itself the OIDC client and proxies `/api/*`
onward to the Go API). This is the browser-based-apps BCP "same-domain" case: it
enables `SameSite=Strict` session cookies with no CORS. The SPA only ever calls
same-origin relative paths, so **`connect-src 'self'` holds unchanged** — the IdP
round trip is a top-level navigation, not a fetch, and the token endpoint is
called server-side by the BFF. That is the headline security win of the BFF.

## Reading further

- `lib/api/client.ts` is the reference for rules 1–4, 8. The three auth-seam
  hooks (`credentials: 'include'`, CSRF header, 401→login) all live there.
- When in doubt, mirror what the `lib/` modules already do, and read
  [decisions.md](./decisions.md) before changing anything adjacent.
