#!/usr/bin/env node
// Loads the built bundle in a real browser, walks the code-split routes via the
// SPA nav, and fails if the page raises any Content-Security-Policy violations, or
// any script-src violation specifically. This is how the CSP rule in
// .claude/rules/security.md is *proven*, not asserted.
//
// Usage:
//   pnpm build && pnpm exec vite preview --port 4173 --strictPort &
//   node scripts/check-csp.mjs http://localhost:4173
//
// `make csp-check` wires the build + preview + this script together.
import { chromium } from 'playwright'

const url = process.argv[2] || 'http://localhost:4173'

const browser = await chromium.launch()
const page = await browser.newPage()

const violations = []
// CSP violations surface as console errors AND as securitypolicyviolation events.
await page.addInitScript(() => {
  document.addEventListener('securitypolicyviolation', (e) => {
    // Stash on window so the test side can read it.
    ;(window.__cspViolations ||= []).push({
      directive: e.violatedDirective,
      blockedURI: e.blockedURI,
    })
  })
})

page.on('console', (msg) => {
  const text = msg.text()
  // Ignore the informational note that header-only directives (frame-ancestors,
  // sandbox, report-uri) are ignored in a <meta> tag — those are delivered as
  // headers by the Caddyfile, not the meta tag. Not a content violation.
  const isMetaOnlyNote = /ignored when delivered via a <meta>/i.test(text)
  if (msg.type() === 'error' && /Content Security Policy/i.test(text) && !isMetaOnlyNote) {
    violations.push({ directive: 'console', blockedURI: text })
  }
})

const response = await page.goto(url, { waitUntil: 'networkidle' })
if (!response || !response.ok()) {
  console.error(`✗ Failed to load ${url} (status ${response?.status()})`)
  await browser.close()
  process.exit(1)
}

// Exercise the CODE-SPLIT routes through the SPA path, not fresh gotos: each
// route is a lazy import() whose chunk injects its CSS via a runtime <style>
// element — the exact `style-src 'unsafe-inline'` compromise under test. Clicking
// the in-page nav links loads those chunks client-side (History API, no reload),
// so a CSP that only holds for the initial shell but breaks on a lazily-loaded
// route is caught here. We visit /login and an unknown (404) path.
for (const href of ['/login', '/does-not-exist']) {
  await page.click(`a[href="${href}"]`)
  await page.waitForLoadState('networkidle')
}

const reported = await page.evaluate(() => window.__cspViolations || [])
violations.push(...reported)

await browser.close()

if (violations.length > 0) {
  console.error(`✗ ${violations.length} CSP violation(s) on ${url}:`)
  for (const v of violations) console.error(`  - ${v.directive}: ${v.blockedURI}`)
  const scriptViolations = violations.filter((v) => String(v.directive).startsWith('script-src'))
  if (scriptViolations.length > 0) {
    console.error('  (includes script-src violations — strict script policy is broken)')
  }
  process.exit(1)
}

console.log(`✓ No CSP violations on ${url}. script-src 'self' holds.`)
