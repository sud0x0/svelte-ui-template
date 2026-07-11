# bff/ — the Backend-for-Frontend

A small confidential-OIDC-client service that logs the user in (Authorization
Code + PKCE), keeps **all** tokens server-side, gives the browser only a
`__Host-` session cookie, and proxies `/api/*` to the Go API with
`Authorization: Bearer <access token>` attached. The browser never holds a token.

This is the top-ranked architecture of the IESG-approved
[OAuth 2.0 for Browser-Based Applications](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps)
BCP (Section 6.1).

**Full documentation — architecture diagram, env table, IdP checklist, and the
production-hardening notes — lives in the main [README "Authentication"
section](../README.md#authentication)** and the
[`/auth-integration`](../.claude/skills/auth-integration/SKILL.md) skill. This
file is only a pointer so the directory is not silent.

## Module map

| File                  | Responsibility                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config.ts`       | The one `process.env` read site; fail-fast validation.                                                                                                                        |
| `src/session.ts`      | In-memory session store + the `__Host-` cookie contract (BCP 6.1.3.2).                                                                                                        |
| `src/valkey-store.ts` | OPTIONAL Valkey-backed session + txn store (durable / multi-instance) — off by default. See the README ["Session store (production)"](../README.md#session-store-production). |
| `src/csrf.ts`         | Signed double-submit CSRF (HMAC) + the Sec-Fetch-Site gate.                                                                                                                   |
| `src/oidc.ts`         | The confidential OIDC client (discovery, login, callback, refresh).                                                                                                           |
| `src/routes/auth.ts`  | `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/me`.                                                                                                                  |
| `src/proxy.ts`        | Authenticated `/api/*` proxy with server-side refresh.                                                                                                                        |
| `src/server.ts`       | Composition root: config → routes → proxy → HTTP server.                                                                                                                      |

## Run

```bash
pnpm bff:dev      # watch-mode dev server (Node native type-stripping)
pnpm bff:build    # bundle to bff/dist/server.mjs (esbuild)
make bff-test     # BFF unit tests (Vitest, node environment)
```

Requires the `BFF_*` environment (see [`.env.example`](../.env.example)).
