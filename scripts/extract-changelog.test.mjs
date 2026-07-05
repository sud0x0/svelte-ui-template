// Tests for extract-changelog.sh — run with `node --test scripts/` (make test-scripts).
// Mirrors go-api-template's extract_changelog_test.go: the release pipeline
// depends on this script, so its exit codes are pinned by tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = new URL('./extract-changelog.sh', import.meta.url).pathname

function run(version, body) {
  return runArgs([version], body)
}

// Like run(), but takes the full argv (e.g. ['--allow-empty', 'Unreleased']) so
// the flag path can be exercised. The changelog path is always appended last.
function runArgs(args, body) {
  const dir = mkdtempSync(join(tmpdir(), 'cl-'))
  const path = join(dir, 'CHANGELOG.md')
  writeFileSync(path, body)
  try {
    const out = execFileSync('sh', [SCRIPT, ...args, path], { encoding: 'utf8' })
    return { code: 0, out }
  } catch (err) {
    return { code: err.status, out: err.stdout ?? '', errOut: err.stderr ?? '' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const SAMPLE = `# Changelog

## [Unreleased]

- pending work

## [1.2.3] - 2026-01-01

### Added

- a feature

## [1.2.2] - 2025-12-01

- older
`

test('prints the body of a matching section (exit 0)', () => {
  const { code, out } = run('1.2.3', SAMPLE)
  assert.equal(code, 0)
  assert.match(out, /### Added/)
  assert.match(out, /a feature/)
  assert.doesNotMatch(out, /older/) // stops at the next section
  assert.doesNotMatch(out, /## \[1\.2\.3\]/) // heading itself excluded
})

test('does not match a longer version prefix (1.2.3 vs 1.2.31)', () => {
  const body = SAMPLE.replace('[1.2.3]', '[1.2.31]')
  const { code } = run('1.2.3', body)
  assert.equal(code, 1) // 1.2.3 section is absent
})

test('exits 1 when the section is missing', () => {
  const { code } = run('9.9.9', SAMPLE)
  assert.equal(code, 1)
})

test('exits 1 when the section is empty', () => {
  const body = `# Changelog\n\n## [1.0.0]\n\n## [0.9.0]\n\n- x\n`
  const { code } = run('1.0.0', body)
  assert.equal(code, 1)
})

// --- hardened emptiness (headings/comments ignored) + --allow-empty flag ------

// Only the seeded group headings under the section — no real notes.
const HEADING_ONLY = `# Changelog\n\n## [1.0.0]\n\n### Added\n\n### Changed\n\n## [0.9.0]\n\n- x\n`

test('heading-only body exits 1 without the flag but 0 with --allow-empty', () => {
  assert.equal(run('1.0.0', HEADING_ONLY).code, 1)
  assert.equal(runArgs(['--allow-empty', '1.0.0'], HEADING_ONLY).code, 0)
})

// A multi-line HTML comment is the only thing in the body — still empty.
const COMMENT_ONLY = `# Changelog\n\n## [1.0.0]\n\n<!-- add\nentries\nhere -->\n\n## [0.9.0]\n\n- x\n`

test('HTML-comment-only body exits 1 without the flag', () => {
  assert.equal(run('1.0.0', COMMENT_ONLY).code, 1)
})

// Headings + a comment + one real bullet counts as content.
const HEADINGS_COMMENT_BULLET = `# Changelog\n\n## [1.0.0]\n\n### Added\n\n<!-- note -->\n\n- a real bullet\n\n## [0.9.0]\n\n- x\n`

test('a body with headings + comment + one real bullet exits 0 and prints the bullet', () => {
  const { code, out } = run('1.0.0', HEADINGS_COMMENT_BULLET)
  assert.equal(code, 0)
  assert.match(out, /- a real bullet/)
})

test('a missing section still exits 1 even with --allow-empty', () => {
  assert.equal(runArgs(['--allow-empty', '9.9.9'], SAMPLE).code, 1)
})
