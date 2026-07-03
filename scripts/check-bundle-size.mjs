#!/usr/bin/env node
// Gzipped-size budget gate for the production bundle. Fails (exit 1) if the
// total gzipped JS+CSS in dist/ exceeds the budget — keeps bundle creep visible
// in CI. Run after `vite build`. See README "Code quality".
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const DIST = 'dist'

// Budget for the WHOLE bundle (all chunks + CSS), gzipped. The template ships
// with zero runtime dependencies, so this sits comfortably high; tighten it as
// the app grows, or split into per-chunk budgets.
const BUDGET_BYTES = 150 * 1024

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

let files
try {
  files = walk(DIST)
} catch {
  console.error(`✗ ${DIST}/ not found — run \`pnpm build\` first.`)
  process.exit(1)
}

const assets = files
  .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
  .map((f) => {
    const gz = gzipSync(readFileSync(f)).length
    return { file: f, gz }
  })
  .sort((a, b) => b.gz - a.gz)

const total = assets.reduce((sum, a) => sum + a.gz, 0)
const kib = (n) => `${(n / 1024).toFixed(1)} KiB`

console.log('Gzipped bundle assets:')
for (const a of assets) {
  console.log(`  ${kib(a.gz).padStart(10)}  ${a.file}`)
}
console.log(`  ${'—'.repeat(10)}`)
console.log(`  ${kib(total).padStart(10)}  total (budget ${kib(BUDGET_BYTES)})`)

if (total > BUDGET_BYTES) {
  console.error(`\n✗ Bundle exceeds budget by ${kib(total - BUDGET_BYTES)}.`)
  process.exit(1)
}
console.log('\n✓ Within budget.')
