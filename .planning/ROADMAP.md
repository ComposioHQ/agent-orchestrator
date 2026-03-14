# Roadmap: Agent Orchestrator Pixel Dashboard

## Overview

This roadmap delivers a second dashboard mode for `agent-orchestrator` without splitting operational truth from the current product. The sequence stays parity-first: establish the shared dashboard foundation, build the pixel world on top of the existing data model, bring over the main operator workflows, then harden trust and usability for a dependable v1 release.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [x] **Phase 1: Shared Dashboard Foundation** - Add the mode switcher and shared live-state seams that keep both dashboards aligned. Completed 2026-03-14.
- [ ] **Phase 2: Pixel World Core** - Render the pixel scene with stable session entities, navigation, and selection.
- [ ] **Phase 3: Operator Workflow Parity** - Restore the main inspection and action workflows inside the pixel dashboard.
- [ ] **Phase 4: Trust And Operational Polish** - Tighten stale-state signaling, visual scanability, and desktop usability so operators can trust the mode daily.

## Phase Details

### Phase 1: Shared Dashboard Foundation
**Goal**: Establish one shared dashboard shell and live data contract so the legacy and pixel views can coexist without backend drift.
**Depends on**: Nothing (first phase)
**Requirements**: NAV-01, NAV-02, NAV-03, LIVE-01, LIVE-02
**Success Criteria** (what must be TRUE):
  1. Operator can switch between legacy and pixel dashboard views from a visible in-app control.
  2. Operator keeps the active project scope when changing dashboard views.
  3. Pixel mode works in both single-project and all-project contexts.
  4. Live session updates, additions, and removals reach the pixel mode through the same session/event contract as the legacy dashboard.
**Plans**: TBD

Plans:
- [x] 01-01: Reuse the current session/event loading path and shared route-state for both dashboard modes
- [x] 01-02: Define the shared dashboard shell, mode switcher, and Phase 1 pixel body seam

### Phase 2: Pixel World Core
**Goal**: Translate current dashboard sessions into a usable 2D pixel world with stable scene behavior and selection.
**Depends on**: Phase 1
**Requirements**: SCENE-01, SCENE-02, SCENE-03, SCENE-04
**Success Criteria** (what must be TRUE):
  1. Operator can see one stable scene entity for each worker session shown by the current dashboard.
  2. Operator can recognize urgency in the world using the same underlying attention semantics as the legacy dashboard.
  3. Operator can pan and zoom the scene without losing access to shared shell controls or blocking future detail surfaces.
  4. Operator can select a session entity and keep that selection stable while live updates arrive.
**Plans**: TBD

Plans:
- [x] 02-01: Build the DOM scene renderer, world model, and session-to-entity mapping
- [ ] 02-02: Add camera controls, selection behavior, and scene interaction boundaries

### Phase 3: Operator Workflow Parity
**Goal**: Make the pixel dashboard operationally useful by bringing over the main inspection surfaces and daily session actions.
**Depends on**: Phase 2
**Requirements**: INSP-01, INSP-02, ACT-01, ACT-02, ACT-03, ACT-04, UX-02
**Success Criteria** (what must be TRUE):
  1. Operator can inspect selected session details including summary, branch, issue context, and recent state from a non-canvas UI surface.
  2. Operator can inspect PR state for a selected session, including review, CI, and merge-readiness cues.
  3. Operator can send, kill, restore, and merge from the pixel dashboard using the current operational actions.
  4. Dense operational details stay readable without overloading the scene itself.
**Plans**: TBD

Plans:
- [ ] 03-01: Build the inspect drawer and parity detail surfaces
- [ ] 03-02: Wire current session and PR actions into the pixel dashboard

### Phase 4: Trust And Operational Polish
**Goal**: Improve trust, scanability, and desktop usability so the pixel dashboard feels dependable rather than merely novel.
**Depends on**: Phase 3
**Requirements**: INSP-03, LIVE-03, UX-01, UX-03
**Success Criteria** (what must be TRUE):
  1. Operator can tell when session or PR information is stale, paused, or limited by backend conditions.
  2. Counts and core states shown in the pixel dashboard stay aligned with the legacy dashboard during normal use.
  3. Operator can distinguish working, waiting, review-needed, merge-ready, and done sessions through clear visual cues.
  4. Operator can use the pixel dashboard on common desktop viewport sizes without the scene becoming unusable.
**Plans**: TBD

Plans:
- [ ] 04-01: Add trust markers and alignment checks for stale, paused, and degraded states
- [ ] 04-02: Refine visual cues and desktop usability for daily operator scanning

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Shared Dashboard Foundation | 2/2 | Complete | 2026-03-14 |
| 2. Pixel World Core | 1/2 | In Progress | - |
| 3. Operator Workflow Parity | 0/2 | Not started | - |
| 4. Trust And Operational Polish | 0/2 | Not started | - |
