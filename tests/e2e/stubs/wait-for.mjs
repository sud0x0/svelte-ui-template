// Tiny readiness gate for the Playwright webServer chain: poll a URL until it
// answers, then exit 0. Used so the real BFF only starts AFTER the stub IdP is
// serving discovery — the BFF does OIDC discovery once at boot and fails fast if
// the issuer is unreachable, so ordering matters. Usage: node wait-for.mjs <url>
const url = process.argv[2]
const deadline = Date.now() + 30_000

async function poll() {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  console.error(`wait-for: ${url} did not become ready in time`)
  process.exit(1)
}

await poll()
