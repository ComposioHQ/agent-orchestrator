---
phase: 02
slug: pixel-world-core
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-14
---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `packages/web/vitest.config.ts` |
| **Quick run command** | `pnpm --filter @composio/ao-web test -- pixel-dashboard scene-model camera selection` |
| **Full suite command** | `pnpm --filter @composio/ao-web test -- ProjectSidebar Dashboard.projectOverview useSessionEvents pixel-dashboard scene-model camera selection && pnpm --filter @composio/ao-web typecheck` |
| **Estimated runtime** | ~25 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter @composio/ao-web test -- pixel-dashboard scene-model camera selection`
- **After every plan wave:** Run `pnpm --filter @composio/ao-web test -- ProjectSidebar Dashboard.projectOverview useSessionEvents pixel-dashboard scene-model camera selection && pnpm --filter @composio/ao-web typecheck`
- **Before `$gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | SCENE-01 | unit | `pnpm --filter @composio/ao-web test -- scene-model` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 1 | SCENE-02 | component | `pnpm --filter @composio/ao-web test -- pixel-dashboard` | ❌ W0 | ⬜ pending |
| 02-02-01 | 02 | 2 | SCENE-03 | unit | `pnpm --filter @composio/ao-web test -- camera` | ❌ W0 | ⬜ pending |
| 02-02-02 | 02 | 2 | SCENE-04 | unit/component | `pnpm --filter @composio/ao-web test -- selection useSessionEvents pixel-dashboard` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/web/src/components/pixel-dashboard/__tests__/scene-model.test.ts` — deterministic district and session placement for SCENE-01
- [ ] `packages/web/src/components/pixel-dashboard/__tests__/PixelDashboardView.test.tsx` — entity rendering, labels, and urgency cues for SCENE-02
- [ ] `packages/web/src/components/pixel-dashboard/__tests__/camera.test.ts` — zoom clamps, pan bounds, and initial framing for SCENE-03
- [ ] `packages/web/src/components/pixel-dashboard/__tests__/selection.test.ts` — id-based selection persistence and offscreen locator behavior for SCENE-04

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| District positions stay visually stable while live sessions churn | SCENE-01 | Requires seeing real-world spatial continuity under live updates | Enter pixel mode in all-project view, trigger a membership refresh, and confirm districts do not reshuffle |
| Pan/zoom remains usable alongside the shared shell | SCENE-03 | Best validated with actual pointer interaction and shell chrome on screen | Drag and wheel through a populated district, then confirm mode switcher and shell controls remain accessible |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
