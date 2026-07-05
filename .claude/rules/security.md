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

1. **Auth seam is OIDC/BFF-shaped and token-free.** Authentication is _not_
   implemented; only the seam is. When implemented it MUST be the Backend-For-
   Frontend model: the Go API holds all tokens, the browser gets an
   `HttpOnly; Secure; SameSite=Strict`, `__Host-`-prefixed session cookie, and
   the SPA stores/parses **no** access, refresh, or ID token. The browser-based
   OAuth-client alternative (tokens in memory, PKCE in `sessionStorage`) is a
   recorded _weaker_ fallback in [decisions.md](./decisions.md), not the intended
   design. Cite [draft-ietf-oauth-browser-based-apps](https://datatracker.ietf.org/doc/draft-ietf-oauth-browser-based-apps/)
   and [RFC 9700](https://www.rfc-editor.org/info/rfc9700).

   **`return_to` is an open-redirect sink — the BFF MUST validate it.** The SPA
   passes `?return_to=` through opaquely (it captures `location.pathname +
location.search` and cannot be trusted to sanitise it), so the BFF's
   `/auth/login` and `/auth/callback` MUST accept `return_to` **only** as a
   same-site relative path: it MUST start with a single `/` and MUST be rejected
   if it starts with `//` or `/\` (protocol-relative), contains a backslash, or
   carries any scheme or authority (`https:`, `javascript:`, `user@host`, …). On
   any failure, fall back to `/`. An unvalidated redirect target is an open
   redirect ([OWASP Unvalidated Redirects & Forwards](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html)).
   See [auth-integration](../skills/auth-integration/SKILL.md).

2. **CSRF defence in depth for the cookie session.** `SameSite=Strict` is
   necessary but, per the [OWASP CSRF Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
   ("should not be the sole defence") and [MDN](https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/CSRF_prevention)
   ("not a complete defense"), it must not be the only control. State-changing
   requests (`POST/PUT/PATCH/DELETE`) carry an additional control — a
   double-submit `X-CSRF-Token` header (chosen). **The `csrf` cookie value the
   BFF sets MUST be a session-bound HMAC token — the _signed_ double-submit
   pattern, not a bare random value.** The naive double-submit cookie is still
   forgeable via cookie injection from a sibling subdomain or a MITM, so the
   OWASP CSRF Cheat Sheet says to "always prefer the Signed Double-Submit Cookie
   pattern with session-bound HMAC tokens"; the BFF verifies the HMAC server-side.
   Fetch-Metadata (`Sec-Fetch-Site`) validation with an Origin-header fallback is
   the acceptable alternative control. Either way **the SPA is unchanged**:
   `lib/api/client.ts` just echoes whatever `csrf` cookie the BFF set back in the
   `X-CSRF-Token` header on unsafe methods **today** (inert until the BFF sets the
   cookie) — it neither mints nor validates the token.

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
   `assertCurrentUser`, `isApiError`) before it reaches components.

9. **No secrets in the bundle.** Only `VITE_`-prefixed, non-secret config reaches
   the client; the future OIDC client secret lives only in the Go BFF. `.env` is
   git-ignored; `.env.example` documents every variable. gitleaks runs in
   pre-commit and CI (and scans `.claude/`).

10. **Dependencies are a supply-chain decision.** Any new runtime dependency is
    justified in the commit body. SBOM (Syft) + `make socket` (Socket.dev) back
    this up. The template ships with **zero** runtime dependencies — keep it lean.

## Same-origin model

SPA and Go API are same-origin behind Caddy, which reverse-proxies `/api/*`,
`/auth/*`, and `/health` to the backend. This is the browser-based-apps BCP
"same-domain" case: it enables `SameSite=Strict` session cookies with no CORS.
The SPA only ever calls same-origin relative paths.

## Reading further

- `lib/api/client.ts` is the reference for rules 1–4, 8. The three auth-seam
  hooks (`credentials: 'include'`, CSRF header, 401→login) all live there.
- When in doubt, mirror what the `lib/` modules already do, and read
  [decisions.md](./decisions.md) before changing anything adjacent.
