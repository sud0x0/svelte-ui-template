---
name: security-review
description: Security-review a change, PR, or the working tree in this svelte-ui-template SPA. Use when the user says "security review this", "is this secure", "check for vulnerabilities", or asks whether new code respects the repo's front-end security rules. Walks the rules in .claude/rules/security.md with file-cited verdicts, greps for the known anti-patterns (Web Storage tokens, {@html}, raw fetch, missing credentials/CSRF, id_token handling), confirms the built bundle loads under CSP, and runs the scanner suite.
---

# /security-review — review a change against the front-end rules

Two documents drive the review:

- **Write-time rule set:** [`security.md`](../../rules/security.md) — the ten
  rules (source of truth), demonstrated by the reference modules under `src/lib/`.
- **Verification map:** [`references/asvs-map.md`](references/asvs-map.md) — the
  front-end-applicable OWASP **ASVS 5.0.0 (Level 2)** requirements, each mapped to
  the repo control that satisfies it and the test that proves it, built by reading
  the committed standard ([`references/asvs-5.0.0.txt`](references/asvs-5.0.0.txt)).

Take a diff or the working tree, check it against the rules, walk the ASVS
requirements the change touches, then run the scanners. **Cite evidence for every
verdict** — a `file:line`, a grep result, or a scanner line — and, where it
applies, the **ASVS requirement ID** (reference form: `V<n>` for a chapter,
`<n>.<section>.<index>` for a requirement). "Looks fine" is not a verdict.

**Keep the map current.** Any change that touches a mapped area updates its
`asvs-map.md` rows **and their test evidence in the same change** — a stale row,
or a `met` row with no named test, is a bug (the map's own maintenance rule).

## Inputs

- **Scope** — the diff (`git diff main...HEAD`), a directory, or the working tree.
  If unstated, default to the working tree and say so.
- Read [decisions.md](../../rules/decisions.md) first: a finding that contradicts
  a settled decision is _intentional_, not a bug.

## Verdict scale

- **Pass** — rule satisfied, with a citation.
- **Pass (template seam)** — not implemented because the template ships only the
  contract (auth); the seam is correct.
- **Gap** — must fix before merge. Cite the offending line.
- **N/A** — change doesn't touch this rule (say why).

## The checks (grep-backed)

| Rule                     | What to check                                                   | How                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 token-free BFF seam    | No access/refresh/ID token stored or parsed anywhere            | `grep -rniE 'access_?token\|refresh_?token\|id_?token\|bearer' src/` → nothing outside comments/docs                                                  |
| 2 CSRF                   | Unsafe methods carry the CSRF control; only `client.ts` owns it | `grep -rn 'X-CSRF-Token' src/` → only `client.ts`                                                                                                     |
| 3 no Web Storage session | No tokens/session in storage; only prefs use it                 | `grep -rnE 'localStorage\|sessionStorage' src/` → only `preferences.svelte.ts`                                                                        |
| 4 ID token ≠ API cred    | No id_token sent to `/api`                                      | covered by rule 1 grep                                                                                                                                |
| 5 no raw HTML            | No `{@html}` on dynamic data                                    | `grep -rn '{@html' src/` → nothing, or sanitised with a comment                                                                                       |
| — single client          | No `fetch` outside the client                                   | `grep -rn 'fetch(' src/ \| grep -v 'lib/api/client.ts'` → nothing                                                                                     |
| — credentials            | Every request includes credentials                              | confirm `credentials: 'include'` in `client.ts`; no second fetch wrapper                                                                              |
| 6 CSP                    | Built bundle loads with no violations; `script-src` strict      | `make csp-check` (builds, serves, loads in a browser)                                                                                                 |
| 7 edge headers           | Caddyfile sets the full header set                              | read `Caddyfile`: CSP + HSTS + nosniff + `X-Frame-Options: DENY` + `frame-ancestors 'none'` + Referrer-Policy + Permissions-Policy + COOP + `-Server` |
| 8 boundary validation    | API JSON narrowed via guards before components                  | `grep -rn 'assert\|isApiError' src/lib/types/api.ts`; new resources call a guard                                                                      |
| 9 no secrets             | Only `VITE_`-prefixed config in the bundle; `.env` ignored      | `grep -rn 'import.meta.env' src/` → only `config.ts` (+ `vite-env.d.ts`)                                                                              |
| 10 deps                  | Any new runtime dep justified                                   | read the diff's `package.json`; check `dependencies` (not just dev)                                                                                   |
| — no `any`               | strict types                                                    | `grep -rn ': any\|<any>\| as any' src/` → nothing                                                                                                     |

## Run the scanners (report exact results)

```bash
make csp-check          # builds + serves + loads the bundle; fails on any CSP violation
make semgrep            # static anti-patterns (needs semgrep)
pre-commit run gitleaks --all-files   # committed secrets (scans .claude/ too)
pnpm audit              # known-vuln dependencies
make socket             # Socket.dev supply-chain (needs the socket CLI + login)
```

Note which need tools you don't have installed — say so, do not imply they passed.
`make csp-check` needs Playwright browsers (`pnpm exec playwright install chromium`).

## Output

1. **Summary table** — `Rule/Check → Verdict → one-line citation`.
2. **Findings** — each Gap with `file:line`, why it breaks the rule, the minimal
   fix. Intentional-by-decisions items listed separately.
3. **Commands run** — with actual result lines, or a note that a tool was
   unavailable.

## Non-negotiables

- Cite evidence for every verdict. - Never weaken a rule to make code pass.
- Respect [decisions.md](../../rules/decisions.md).
