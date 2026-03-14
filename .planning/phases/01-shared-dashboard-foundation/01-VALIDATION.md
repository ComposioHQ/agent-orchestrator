---
phase: 01
slug: shared-dashboard-foundation
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-14
---

# Phase 01 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `packages/web/vitest.config.ts` |
| **Quick run command** | `pnpm --filter @composio/ao-web test -- ProjectSidebar useSessionEvents api-routes` |
| **Full suite command** | `pnpm --filter @composio/ao-web test` |
| **Estimated runtime** | ~30-90 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter @composio/ao-web test -- ProjectSidebar useSessionEvents api-routes`
- **After every plan wave:** Run `pnpm --filter @composio/ao-web test`
- **Before `$gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 90 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | NAV-01 | component | `pnpm --filter @composio/ao-web test -- ProjectSidebar` | ✅ | ⬜ pending |
| 01-01-02 | 01 | 1 | NAV-02 | hook/api | `pnpm --filter @composio/ao-web test -- useSessionEvents api-routes` | ✅ | ⬜ pending |
| 01-01-03 | 01 | 1 | LIVE-01 | hook | `pnpm --filter @composio/ao-web test -- useSessionEvents` | ✅ | ⬜ pending |
| 01-02-01 | 02 | 1 | NAV-03 | component | `pnpm --filter @composio/ao-web test -- Dashboard.projectOverview` | ✅ | ⬜ pending |
| 01-02-02 | 02 | 1 | LIVE-02 | api/hook | `pnpm --filter @composio/ao-web test -- useSessionEvents api-routes` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] Existing `packages/web/vitest.config.ts` covers the web package
- [x] Existing tests in `packages/web/src/components/__tests__/ProjectSidebar.test.tsx` provide a base for query-param preservation
- [x] Existing tests in `packages/web/src/hooks/__tests__/useSessionEvents.test.ts` provide a base for live session contract coverage
- [x] Existing tests in `packages/web/src/__tests__/api-routes.test.ts` provide a base for shared API payload coverage

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Shared header shell feels consistent across legacy and pixel modes | NAV-01 | Visual/design continuity is hard to assert fully in unit tests | Run the web app, switch between modes, and confirm the title, status line, banners, and switcher remain in a stable shared shell |
| `project=all&view=pixel` reads as clearly separated project districts | NAV-03 | The Phase 1 placeholder/grouping semantics are visual and product-facing | Run the app with all-project mode, switch to pixel view, and confirm project grouping is immediately understandable |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 90s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
