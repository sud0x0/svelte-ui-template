---
name: auth-integration
description: Complete the token-free auth SEAM in this svelte-ui-template into a real OpenID Connect Backend-For-Frontend (BFF). Use when the user is ready to turn on authentication — "wire up auth", "connect to the BFF", "enable OIDC login", "flip VITE_AUTH_MODE to bff". This completes an existing seam; it does NOT invent auth from scratch and does NOT implement the OIDC flow in the SPA (that is the Go BFF's job). Cross-references the Go API template's r.Route("/api/v1", …) seam.
---

# /auth-integration — complete the seam into a BFF

Authentication is intentionally **not** implemented in this template — only the
seam is (see [decisions.md](../../rules/decisions.md) #1–#3). This skill flips it
on against a real Backend-For-Frontend. The SPA still holds **no tokens** — the
Go API does. **Read [security.md](../../rules/security.md) rules 1–4 before
starting.** Do NOT add an OIDC library, PKCE, or token parsing to `src/` — none
of that belongs in the browser.

## What the Go BFF must expose (the contract)

The SPA assumes these same-origin endpoints (proxied by Caddy to the Go API):

| Endpoint         | Method | Responsibility                                                                                                                                                                                                                                              |
| ---------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/auth/login`    | GET    | Build the OIDC Authorization Code + PKCE (S256) request with `state` (CSRF on the redirect) and `nonce` (ID-token replay); 302 to the IdP discovered via `.well-known/openid-configuration`. Honour `?return_to=` **only after validating it** (see below). |
| `/auth/callback` | GET    | Validate `state`; exchange the code; validate the ID token (JWKS/`kid`, `iss`, `aud`, `exp`, `nbf`, `nonce`, **server-side `alg` allowlist**); set the session cookie; redirect to the **validated** `return_to` (else `/`).                                |
| `/auth/me`       | GET    | Return the current `CurrentUser` resolved from the server-side session. **Never** returns a token.                                                                                                                                                          |
| `/auth/logout`   | POST   | Clear the session cookie, then RP-initiated logout at the IdP `end_session_endpoint`.                                                                                                                                                                       |

**`return_to` MUST be validated at the BFF — an unvalidated redirect target is an
open redirect** ([OWASP Unvalidated Redirects & Forwards](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html)).
Accept it **only** as a same-site relative path: it MUST start with a single `/`
and MUST be rejected if it starts with `//` or `/\` (protocol-relative), contains
a backslash, or carries any scheme or authority (`https:`, `javascript:`,
`user@host`, …). On any failure, fall back to `/`. Do this server-side; the SPA
passes `return_to` through opaquely and cannot be trusted to sanitise it.

Cookie rules (BFF sets): `HttpOnly; Secure; SameSite=Strict`, `__Host-` prefix.
Plus a **readable** (non-HttpOnly) `csrf` cookie for the double-submit control —
its value MUST be a **session-bound HMAC token** (the _signed_ double-submit
pattern), not a bare random value: OWASP notes the naive double-submit cookie is
still forgeable via cookie injection from a sibling subdomain / MITM, so it says
"always prefer the Signed Double-Submit Cookie pattern with session-bound HMAC
tokens" ([OWASP CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)).
`Sec-Fetch-Site` (Fetch-Metadata) validation with an Origin-header fallback is the
acceptable alternative. Either way the SPA is unchanged — it just echoes whatever
`csrf` cookie the BFF set back in `X-CSRF-Token` (`client.ts`); the BFF verifies
the HMAC. The ID token is **never** sent to `/api` resource endpoints — it is not
an API credential.

## SPA-side steps (filling the stubs)

1. **Flip the flag.** `VITE_AUTH_MODE=bff` in `.env` (and your deploy env). This
   is the switch — `src/lib/config.ts` reads it.
2. **`src/lib/api/auth.ts`** — each function already has a `// TODO(auth)` branch
   for `bff`:
   - `getCurrentUser()` → `GET /auth/me` (already wired; verify the `CurrentUser`
     shape matches your IdP claims, mapped server-side).
   - `login(returnTo)` → navigates to `/auth/login?return_to=…` (already wired).
   - `logout()` → `POST /auth/logout` then return to `/` (already wired; CSRF
     header attaches via the client).
     Adjust only if your BFF's paths/param names differ.
3. **`src/lib/components/auth/RouteGuard.svelte`** — the `bff` branch fires
   `login(returnTo)` on `authStatus() === 'error'` (a 401 from `/auth/me`).
   Confirm this is the enforcement you want; tighten if you need per-role checks
   (read `authUser()?.roles`).
4. **`src/lib/api/client.ts`** — the 401→`login(returnTo)` seam and the
   `X-CSRF-Token` double-submit header already exist. If you chose Fetch-Metadata
   (`Sec-Fetch-Site`) at the BFF instead, you can drop the header attachment;
   record the change in `decisions.md`.
5. **Honour the token-free / ID-token rules.** Do not add any token to a store,
   variable, `localStorage`, or `sessionStorage`. `auth.svelte.ts` stays
   profile-only.

## Cross-link to the Go API template

The future BFF resolves the user and sets the UUID via `shared.WithUserID` at the
**`r.Route("/api/v1", …)`** block in `cmd/api/main.go`; handlers read it via
`shared.UserIDFromContext` (which enforces the UUID contract). Implement OIDC in
**lockstep** across the two repos: the SPA seam here and the middleware seam
there. See [go-api-template](https://github.com/sud0x0/go-api-template) README
"Authentication" and its decisions #13.

## Standards to follow (cite in the PR)

- [draft-ietf-oauth-browser-based-apps](https://datatracker.ietf.org/doc/draft-ietf-oauth-browser-based-apps/) (BFF, same-domain)
- [RFC 9700](https://www.rfc-editor.org/info/rfc9700) (OAuth 2.0 Security BCP)
- [OAuth 2.1](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/), [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)
- OWASP [CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), [Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [CSP](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html) cheat sheets

## Verify

`make verify`; `make test-e2e` (the `auth-seam` Playwright project mocks the BFF
and asserts the redirect + `return_to`). Then run against a real IdP in a staging
deploy — the template cannot verify live OIDC.
