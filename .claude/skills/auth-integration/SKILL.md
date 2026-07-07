---
name: auth-integration
description: Operate and harden the SHIPPED reference Backend-for-Frontend (BFF) that implements token-free OIDC for this svelte-ui-template. Use when turning on real authentication — "wire up auth", "connect to the BFF", "enable OIDC login", "flip VITE_AUTH_MODE to bff", "point the BFF at my IdP", "harden the BFF for production". The BFF exists (`bff/`); this skill configures it against a real IdP + Go API and works the production checklist. It does NOT implement the OIDC flow in the SPA (that is the BFF's job) and does NOT add an OIDC library to `src/`.
---

# /auth-integration — operate the shipped reference BFF

Authentication **is** implemented in this template: `bff/` is a confidential OIDC
client (Node/TypeScript, one runtime dependency — `openid-client`). It performs
Authorization Code + PKCE, holds every token server-side, gives the browser only a
`__Host-` session cookie, and proxies `/api/*` to the Go API with the access token
attached. The SPA holds **no tokens** — that is the whole point (BFF is §6.1 of
[draft-ietf-oauth-browser-based-apps](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps),
an IESG-approved BCP). This skill is about **operating** it, not building it.

**Read [security.md](../../rules/security.md) rules 1–4, 11 and
[decisions.md](../../rules/decisions.md) #16–#19 first.** Do NOT add an OIDC
library, PKCE, or token parsing to `src/` — none of that belongs in the browser.

## Module map (`bff/src/`)

| Module           | Owns                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`      | The ONE `process.env` read site. Fail-fast validation of `BFF_*`; derives `redirect_uri` from `BFF_PUBLIC_ORIGIN`.                    |
| `session.ts`     | In-memory session + login-transaction stores; `__Host-session` / `__Host-txn` cookie serialization (BCP §6.1.3.2).                    |
| `csrf.ts`        | The signed double-submit token — `HMAC-SHA256(BFF_COOKIE_SECRET, sessionId)`; the `Sec-Fetch-Site` gate; constant-time verify.        |
| `oidc.ts`        | Wraps `openid-client`: discovery at startup, `beginLogin` (state/nonce/PKCE), `completeLogin`, `refresh`, `endSessionUrl`.            |
| `routes/auth.ts` | `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/me`; `validateReturnTo`; `mapClaimsToUser` (mirrors Go's `mapClaimsToRoles`). |
| `proxy.ts`       | Authenticated `/api/*` reverse proxy: bearer attach, header stripping, single-flight refresh, `/health` passthrough.                  |
| `http.ts`        | Small helpers (cookies, JSON/empty/redirect responses, the Go `401`/`403` envelopes). No dependencies.                                |
| `server.ts`      | Composition root: config → oidc → routes → proxy → HTTP server; privacy-preserving request logger; SIGTERM shutdown.                  |

## Endpoint contract

| Endpoint         | Method | Responsibility                                                                                                                                                                                                        |
| ---------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/auth/login`    | GET    | Validate `?return_to=` (same-site relative only); create a login transaction in a `__Host-txn` cookie (5-min TTL); 302 to the IdP, `code_challenge_method=S256`.                                                      |
| `/auth/callback` | GET    | Consume the transaction **once**; `openid-client` validates `state`/`nonce`; exchange the code with secret + verifier; validate the ID token; create the session; set both cookies; 302 to the validated `return_to`. |
| `/auth/me`       | GET    | Session → `{id, displayName, email?, roles}`. No session → the Go `401 {"error":"unauthorised"}` envelope so the SPA's 401 seam fires. Never a token.                                                                 |
| `/auth/logout`   | POST   | CSRF-protected. Destroy session, expire cookies; `200 {"logout_url"}` when the IdP advertises `end_session_endpoint`, else `204`.                                                                                     |
| `/api/*`         | any    | Strip inbound `Authorization`/`Cookie`; attach the session's bearer; single-flight pre-emptive refresh (rotated); pass status/body through untouched.                                                                 |

## Session & CSRF contract

- **Session cookie** `__Host-session`: `Secure; HttpOnly; SameSite=Strict; Path=/`,
  no `Domain`, no `Max-Age` (BCP §6.1.3.2). The SPA never reads it.
- **CSRF cookie** `csrf`: `Secure; SameSite=Strict`, **not** `HttpOnly` (the SPA
  must echo it). Its value is the session-bound HMAC — being readable is harmless
  (security.md rule 2). The SPA echoes it in `X-CSRF-Token` on unsafe methods;
  `client.ts` neither mints nor validates it.
- **Defence in depth**: an unsafe request with `Sec-Fetch-Site: cross-site` is
  rejected before the CSRF check.

## Going live (configuration, not code)

1. **Register a confidential client** at your IdP (it has a `client_secret`).
   Redirect URI: exactly `<BFF_PUBLIC_ORIGIN>/auth/callback`. Enable PKCE (S256)
   and refresh-token rotation. **No token-endpoint CORS** — the exchange is
   server-side.
2. **Set the `BFF_*` env** (see `.env.example` / the README env table).
   `BFF_COOKIE_SECRET` must be ≥32 bytes of real entropy.
3. **Flip `VITE_AUTH_MODE=bff`** and point `VITE_API_TARGET` at the BFF
   (`http://bff:8081` in-compose, `http://localhost:8081` bare-metal).
4. **Match the Go API**: its `OIDC_ISSUER_URL`/`OIDC_AUDIENCE` must equal what the
   IdP mints for this client. In this same-origin topology the Go CORS middleware
   can be removed (its own comment says so) — the browser never calls it cross-origin.
5. **Verify**: `make bff-test` (unit), `make test-e2e` (the `bff` Playwright
   project drives the real BFF against a stub IdP + API), then a staging run
   against the real IdP — the template cannot verify live OIDC.

## Production-hardening checklist

The shipped BFF is a faithful **reference**, not turnkey production. Before prod:

- **External session store.** `session.ts` is an in-memory `Map` (decisions #18):
  restarting logs everyone out and it does not scale horizontally. Swap in Redis
  (or a signed-cookie store) behind `createSessionStore()` — one seam.
- **Secret management.** `BFF_CLIENT_SECRET` and `BFF_COOKIE_SECRET` come from the
  environment; source them from a secrets manager (not a checked-in `.env`), and
  rotate them.
- **Absolute session lifetime.** The store applies an idle/absolute TTL; confirm it
  matches your policy and add re-auth for sensitive actions if needed.
- **Consider an off-the-shelf BFF instead.** A mature proxy such as
  [oauth2-proxy](https://github.com/oauth2-proxy/oauth2-proxy) can replace `bff/`
  wholesale. If you adopt one, **verify its upstream-header handling before
  trusting it**: this template's contract is that inbound `Authorization`/`Cookie`
  are stripped and only the BFF's bearer reaches the API (security.md rule 11) —
  confirm your chosen proxy does the same and does not forward the browser's
  credentials.

## Cross-link to the Go API template

The BFF resolves the user; the Go API sets the UUID via `shared.WithUserID` at the
**`r.Route("/api/v1", …)`** block in `cmd/api/main.go`, and handlers read it via
`shared.UserIDFromContext`. See [go-api-template](https://github.com/sud0x0/go-api-template)
README "Authentication" and its decisions #13.

## Standards to cite

- [draft-ietf-oauth-browser-based-apps §6.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps) (BFF, same-domain)
- [RFC 9700](https://www.rfc-editor.org/info/rfc9700) (OAuth 2.0 Security BCP), [RFC 7636](https://www.rfc-editor.org/info/rfc7636) (PKCE)
- [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)
- OWASP [CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), [Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [Unvalidated Redirects](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html) cheat sheets
