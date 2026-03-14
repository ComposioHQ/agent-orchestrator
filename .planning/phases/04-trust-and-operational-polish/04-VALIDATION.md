---
phase: 04
slug: trust-and-operational-polish
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-14
---

# Phase 04 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `packages/web/vitest.config.ts` |
| **Quick run command** | `pnpm --filter @composio/ao-web test -- src/components/__tests__/session-inspection.test.tsx src/components/pixel-dashboard/__tests__/PixelDashboardView.test.tsx src/components/pixel-dashboard/__tests__/scene-model.test.ts src/hooks/__tests__/useSessionEvents.test.ts` |
| **Full suite command** | `pnpm --filter @composio/ao-web test && pnpm --filter @composio/ao-web typecheck` |
| **Estimated runtime** | ~60 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter @composio/ao-web test -- src/components/__tests__/session-inspection.test.tsx src/components/pixel-dashboard/__tests__/PixelDashboardView.test.tsx src/components/pixel-dashboard/__tests__/scene-model.test.ts src/hooks/__tests__/useSessionEvents.test.ts`
- **After every plan wave:** Run `pnpm --filter @composio/ao-web test && pnpm --filter @composio/ao-web typecheck`
- **Before `$gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | INSP-03 | component + unit | `pnpm --filter @composio/ao-web test -- src/components/__tests__/session-inspection.test.tsx src/components/pixel-dashboard/__tests__/PixelDashboardView.test.tsx` | ✅ | ⬜ pending |
| 04-01-02 | 01 | 1 | LIVE-03 | hook + component | `pnpm --filter @composio/ao-web test -- src/hooks/__tests__/useSessionEvents.test.ts src/components/pixel-dashboard/__tests__/PixelDashboardView.test.tsx` | ✅ | ⬜ pending |
| 04-02-01 | 02 | 2 | UX-01 | component + scene-model | `pnpm --filter @composio/ao-web test -- src/components/pixel-dashboard/__tests__/scene-model.test.ts src/components/pixel-dashboard/__tests__/PixelDashboardView.test.tsx` | ✅ | ⬜ pending |
| 04-02-02 | 02 | 2 | UX-03 | component + manual | `pnpm --filter @composio/ao-web test -- src/components/pixel-dashboard/__tests__/PixelDashboardView.test.tsx && pnpm --filter @composio/ao-web typecheck` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] Existing infrastructure covers all phase requirements.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Trust and degraded-state cues feel persistent and unmistakable across shell, scene, and drawer | INSP-03 | Visual prominence and operator confidence are judgment-based | Open pixel mode with rate-limited or paused fixtures and confirm warnings remain visible without drill-in. |
| Alignment warning timing feels appropriate and recovery affordance is understandable | LIVE-03 | Human judgment needed for transient lag vs actionable drift | Simulate stale refresh timing, verify brief settling window, then confirm persistent drift shows warning plus recheck path. |
| State cues stay readable without making the world noisy | UX-01 | Scanability is a visual balance, not just DOM structure | Compare working, waiting, review, merge-ready, and done districts in the browser and confirm priority states stand out while done stays quiet. |
| Tight desktop widths preserve orientation, selection, and above-the-fold trust/action context | UX-03 | Responsive usability and viewport feel require browser validation | Test common laptop widths and confirm the drawer stays persistent, secondary detail compresses first, and the scene remains navigable. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 60s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
