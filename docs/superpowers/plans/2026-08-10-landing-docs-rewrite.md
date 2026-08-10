# Landing Documentation Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite every landing documentation page so it accurately describes the current desktop-first Go daemon, Electron, Chat/TUI, GitHub, browser, review, notification, and mobile product.

**Architecture:** Three non-overlapping content streams update core product pages, guides/configuration, and CLI/built-in capabilities. The root agent then reconciles navigation, removes orphaned legacy pages, audits links and stale terms, and runs the landing checks.

**Tech Stack:** MDX, Fumadocs navigation metadata, Electron/React landing build, Go Cobra source as command truth.

## Global Constraints

- Do not document unsupported plugin marketplace, GitLab/Linear runtime, external notifier, YAML configuration, or public dashboard behavior.
- Keep the primary daemon listener loopback-only and document Connect Mobile as the only supported LAN surface.
- Treat desktop releases as canonical and npm `0.10.0` as frozen legacy only.
- Keep all AO state paths under `~/.ao`.

---

### Task 1: Core product documentation

**Files:** `frontend/src/landing/content/docs/{index,installation,quickstart,platforms,dashboard,architecture,examples,faq,troubleshooting,migration}.mdx`

- [ ] Rewrite each page against `README.md`, `docs/STATUS.md`, and `docs/architecture.md`.
- [ ] Remove old Next.js/YAML/plugin/port/state claims and add current desktop, Chat/TUI, browser, reviews, notifications, and mobile flows.
- [ ] Read every rewritten page and check its links.

### Task 2: Guides and configuration

**Files:** `frontend/src/landing/content/docs/guides/**`, `frontend/src/landing/content/docs/configuration/**`

- [ ] Replace unsupported reaction recipes and positional CLI examples with shipped workflows.
- [ ] Document typed per-project settings, lifecycle automation, multi-project sessions, interface modes, and Connect Mobile security.
- [ ] Update section metadata for the retained pages.

### Task 3: CLI and built-in capabilities

**Files:** `frontend/src/landing/content/docs/cli.mdx`, `frontend/src/landing/content/docs/plugins/**`

- [ ] Rebuild CLI reference from current Cobra commands and flags.
- [ ] Replace the plugin marketplace hierarchy with built-in agent, GitHub, workspace, terminal, and notification capability pages.
- [ ] Remove unsupported integration and authoring pages and update metadata.

### Task 4: Integration audit

**Files:** `frontend/src/landing/content/docs/meta.json` and all retained landing docs.

- [ ] Reconcile top-level navigation with retained pages.
- [ ] Search for stale terms: `agent-orchestrator.yaml`, `~/.agent-orchestrator`, Next.js dashboard ports, `ao dashboard`, `ao plugin`, `ao setup`, `batch-spawn`, `review-check`, and public bind instructions.
- [ ] Resolve every remaining match as historical context or remove it.
- [ ] Validate internal `/docs/` links against files and navigation.
- [ ] Run `npm run frontend:typecheck` and the landing build/typecheck command exposed by the repository.
