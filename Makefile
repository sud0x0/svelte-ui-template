# ============================================================================
# svelte-ui-template — Makefile
# ============================================================================
# Local dev uses podman/podman-compose; the quality + test loop runs on the
# host via pnpm. Two umbrellas gate every change: `ci` (everyday, needs
# chromium) and `verify` (full, = ci + e2e). `make help` lists everything.

COMPOSE_FILE = compose.dev.yaml
APP_CONTAINER = svelte_ui
PROJECT = svelte-ui-template

# Read the version from package.json (single source of truth).
VERSION ?= $(shell node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)

.PHONY: setup install build run stop logs destroy clean \
        prod-bundle prod-image release-check changelog-check \
        ci verify \
        lint fmt fmt-check check \
        test test-unit test-e2e test-coverage test-scripts size csp-check \
        pre-commit-install pre-commit-run semgrep socket help

# `node_modules` is a real-file target: any rule depending on it triggers
# `pnpm install` once (or after `make clean`), then refreshes when the lockfile
# or package.json changes. Generates the MSW worker the browser tests need.
node_modules: package.json pnpm-lock.yaml
	@echo "Installing local dependencies..."
	@pnpm install
	@pnpm exec msw init public --no-save >/dev/null 2>&1 || true
	@touch node_modules

# ============================================================================
# First-time setup
# ============================================================================

setup:
	@echo "Setting up development environment..."
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		echo "Created .env from .env.example — fill in your values, then run make setup again."; \
		echo "(Also ensure this is a git repo, or pre-commit install will fail.)"; \
		exit 1; \
	fi
	@pnpm install
	@pnpm exec msw init public --no-save >/dev/null 2>&1 || true
	@pnpm exec playwright install chromium
	@$(MAKE) pre-commit-install
	@$(MAKE) build
	@echo ""
	@echo "Setup complete. Run 'make help' to see available commands."

pre-commit-install:
	@echo "Installing pre-commit hooks..."
	@pre-commit install
	@pre-commit install --install-hooks
	@echo "Pre-commit hooks installed."

# ============================================================================
# Development (containerised)
# ============================================================================

install:
	@pnpm install
	@pnpm exec msw init public --no-save >/dev/null 2>&1 || true

build:
	@echo "Building development container..."
	@podman-compose -f $(COMPOSE_FILE) build
	@podman-compose -f $(COMPOSE_FILE) up -d
	@echo "Application running at http://localhost:3000 (use 'make logs')."

run:
	@podman-compose -f $(COMPOSE_FILE) up -d
	@echo "Development environment ready at http://localhost:3000"

stop:
	@podman-compose -f $(COMPOSE_FILE) down

logs:
	@podman logs -f $(APP_CONTAINER)

destroy:
	@podman-compose -f $(COMPOSE_FILE) down -v --rmi all
	@podman image prune -f

clean:
	@echo "Cleaning build, test, and release artefacts..."
	@rm -rf node_modules/ dist/ coverage/ playwright-report/ test-results/ .svelte-kit/
	@rm -rf $(PROJECT)-*/ $(PROJECT)-*.tar.gz
	@rm -f *.sbom.json checksums.txt
	@echo "Clean complete."

# ============================================================================
# Testing
# ============================================================================
#
# Taxonomy: each command string lives in exactly ONE target. The umbrellas
# (ci, verify) COMPOSE the granular targets via $(MAKE) — they never repeat a
# command. The browser-mode unit tests need Playwright's chromium, so both
# umbrellas need it; none need podman.

# Umbrella 1 — ci. The everyday gate agents run after every change: lint +
# format + types + unit/component tests + build + bundle-size. Composes the
# granular targets, so no command string is duplicated. NEEDS chromium.
ci:
	@$(MAKE) --no-print-directory lint fmt-check check test-unit size
	@echo ""
	@echo "✓ ci passed (lint, format, types, unit tests, build + size)."

# Umbrella 2 — verify. The full pre-commit gate: ci plus the Playwright E2E
# suite. Composes ci + test-e2e — no command string duplicated. NEEDS browsers.
verify:
	@$(MAKE) --no-print-directory ci test-e2e
	@echo ""
	@echo "✓ verify passed (ci + e2e)."

# Race-free unit + component tests in real-browser Vitest. The canonical unit
# suite. NEEDS chromium.
test-unit: node_modules
	@echo "==> vitest run (browser mode)" && pnpm exec vitest run

# Coverage (v8) against the documented threshold; fails below it. NEEDS chromium.
test-coverage: node_modules
	@echo "==> vitest coverage" && pnpm exec vitest run --coverage

# End-to-end (Playwright). Builds first so `vite preview` serves dist. NEEDS browsers.
test-e2e: node_modules
	@echo "==> playwright test (builds first)"
	@pnpm build
	@pnpm exec playwright test

# Unit + e2e (convenience; the gates are ci / verify). NEEDS browsers.
test: test-unit test-e2e

# Tests for the repo's node scripts (the extract-changelog fixture). The release
# pipeline depends on extract-changelog.sh, so its behaviour is pinned. NO browser.
test-scripts:
	@echo "==> node --test scripts" && node --test scripts/*.test.mjs

# Gzipped bundle-size budget gate (builds, then measures). NO browser.
size: node_modules
	@echo "==> build + bundle-size budget"
	@pnpm build
	@node scripts/check-bundle-size.mjs

# Prove the CSP: build, serve the bundle, load it in a real browser, fail on any
# CSP violation. NEEDS chromium.
csp-check: node_modules
	@echo "==> build + CSP check (real browser on :4173)"
	@pnpm build
	@( pnpm exec vite preview --port 4173 --strictPort >/dev/null 2>&1 & echo $$! > .preview.pid ); \
	sleep 2; \
	node scripts/check-csp.mjs http://localhost:4173; status=$$?; \
	kill `cat .preview.pid` 2>/dev/null; rm -f .preview.pid; \
	exit $$status

# ============================================================================
# Code quality
# ============================================================================

# Run ESLint on TypeScript + Svelte files.
lint: node_modules
	@echo "==> eslint" && pnpm exec eslint .

# Format all files with Prettier.
fmt: node_modules
	@echo "==> prettier --write" && pnpm exec prettier --write .

# Check formatting without writing (used by ci).
fmt-check: node_modules
	@echo "==> prettier --check" && pnpm exec prettier --check .

# Type-check the app (svelte-check) and the Node-context config (tsc).
check: node_modules
	@echo "==> svelte-check + tsc"
	@pnpm exec svelte-check --tsconfig ./tsconfig.app.json
	@pnpm exec tsc -p tsconfig.node.json

# ============================================================================
# Production bundle + release
# ============================================================================

# Reproduce the release bundle locally (static assets + Caddyfile, flat layout).
prod-bundle: node_modules
	@echo "Building static bundle for v$(VERSION)..."
	@pnpm install --frozen-lockfile
	@pnpm exec svelte-check --tsconfig ./tsconfig.app.json
	@pnpm build
	@STAGE=$(PROJECT)-$(VERSION); \
	rm -rf "$$STAGE" "$$STAGE.tar.gz"; \
	mkdir -p "$$STAGE"; \
	cp -R dist/. "$$STAGE/"; \
	cp Caddyfile "$$STAGE/"; \
	tar -czf "$$STAGE.tar.gz" "$$STAGE"; \
	rm -rf "$$STAGE"; \
	echo ""; \
	echo "Bundle: $$STAGE.tar.gz"

# Build the production container image (Caddy serving the static bundle) — an
# alternative to the tarball for image-based deploys. Tags <project>:<version>.
# See container.prod for the run command + required env.
prod-image:
	@echo "Building production image $(PROJECT):$(VERSION)..."
	@podman build -f container.prod -t $(PROJECT):$(VERSION) .
	@echo ""
	@echo "Built $(PROJECT):$(VERSION). Run with SITE_ADDRESS/API_UPSTREAM/ACME_EMAIL — see container.prod."

# Validate the release pipeline end-to-end (build -> tarball -> SBOM ->
# checksums). Mirrors .github/workflows/release.yml. Requires syft.
release-check:
	@command -v syft >/dev/null 2>&1 || { \
		echo "syft not found. Install: https://github.com/anchore/syft#installation"; exit 1; }
	@$(MAKE) prod-bundle VERSION=$(VERSION)
	@echo "==> Generating SBOM..."
	@syft scan dir:. --source-name "$(PROJECT)" --source-version "$(VERSION)" \
		-o spdx-json=$(PROJECT)-$(VERSION).sbom.json
	@echo "==> Computing checksums..."
	@sha256sum $(PROJECT)-$(VERSION).tar.gz $(PROJECT)-$(VERSION).sbom.json > checksums.txt
	@cat checksums.txt
	@echo ""
	@echo "release-check passed. Safe to push a release tag."

# Verify CHANGELOG.md has a non-empty section for a given version BEFORE tagging.
# Usage: make changelog-check VERSION=1.2.3 (no leading v). The Makefile's
# VERSION default comes from package.json (origin = file), so we reject that and
# require the operator to pass VERSION explicitly — the release notes are sourced
# from this section, so a typo'd version must not silently pass.
changelog-check:
	@case "$(origin VERSION)" in \
		"command line"|"environment"|"environment override"|"override") ;; \
		*) echo "usage: make changelog-check VERSION=x.y.z" >&2; exit 2 ;; \
	esac
	@sh ./scripts/extract-changelog.sh "$(VERSION)" >/dev/null && \
		echo "CHANGELOG.md has a non-empty [$(VERSION)] section."

# ============================================================================
# Security scanners
# ============================================================================

pre-commit-run: node_modules
	@pre-commit run --all-files

semgrep:
	@semgrep --config=auto --error --skip-unknown-extensions .

socket:
	@socket scan create .

# ============================================================================
# Help
# ============================================================================

help:
	@echo ""
	@echo "Development"
	@echo "-----------"
	@echo "  setup            First-time setup: copies .env, installs deps + browsers + hooks, builds container"
	@echo "  install          Install local dependencies (+ generate the MSW worker)"
	@echo "  build            Build the dev container and start it"
	@echo "  run              Start the dev container"
	@echo "  stop             Stop the dev container"
	@echo "  logs             View application logs"
	@echo "  destroy          Destroy all containers, volumes, and images"
	@echo "  clean            Delete all build, test, and release artefacts"
	@echo ""
	@echo "Testing"
	@echo "-------"
	@echo "  ci               Everyday gate (needs chromium): lint + format + types + unit + build + size"
	@echo "  verify           Full gate (needs browsers): ci + Playwright E2E"
	@echo "  test-unit        Vitest browser-mode unit + component tests (needs chromium)"
	@echo "  test-e2e         Playwright E2E (builds first; needs browsers)"
	@echo "  test-coverage    Vitest v8 coverage against the documented threshold"
	@echo "  test-scripts     Tests for repo scripts (the extract-changelog fixture)"
	@echo "  test             Unit + e2e (convenience)"
	@echo "  size             Gzipped bundle-size budget gate"
	@echo "  csp-check        Build + serve + prove the CSP in a real browser (needs chromium)"
	@echo ""
	@echo "Code quality"
	@echo "------------"
	@echo "  lint             Run ESLint on .ts and .svelte files"
	@echo "  fmt              Format all files with Prettier"
	@echo "  fmt-check        Check formatting without writing"
	@echo "  check            Type-check: svelte-check + tsc (node config)"
	@echo "  pre-commit-run   Run all pre-commit hooks against all files"
	@echo "  semgrep          Run semgrep security scan"
	@echo "  socket           Run Socket.dev supply-chain scan"
	@echo ""
	@echo "Release"
	@echo "-------"
	@echo "  prod-bundle      Build the release tarball locally (static bundle + Caddyfile)"
	@echo "  prod-image       Build the production container image (Caddy serving dist/)"
	@echo "  release-check    Build + SBOM (syft) + checksums; run before tagging"
	@echo "  changelog-check  Confirm CHANGELOG has a non-empty section (VERSION=x.y.z)"
	@echo ""
	@echo "Typical workflow"
	@echo "----------------"
	@echo "  First time:  make setup"
	@echo "  Daily:       make run -> make logs"
	@echo "  Verify:      make ci   (everyday)  |  make verify  (ci + e2e, before commit)"
	@echo "  Fresh start: make destroy -> make build"
	@echo "  Release:     update CHANGELOG -> make changelog-check VERSION=x.y.z -> git tag vX.Y.Z -> git push --tags"
	@echo "  Tidy up:     make clean"
	@echo ""
