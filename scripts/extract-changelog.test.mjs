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
  const dir = mkdtempSync(join(tmpdir(), 'cl-'))
  const path = join(dir, 'CHANGELOG.md')
  writeFileSync(path, body)
  try {
    const out = execFileSync('sh', [SCRIPT, version, path], { encoding: 'utf8' })
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
