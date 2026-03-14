# Requirements: Agent Orchestrator Pixel Dashboard

**Defined:** 2026-03-14
**Core Value:** Operators can use a pixel-style dashboard without losing the core workflows they rely on in the current dashboard.

## v1 Requirements

Requirements for the first usable pixel dashboard release.

### Navigation

- [ ] **NAV-01**: Operator can switch between the legacy dashboard and the pixel dashboard from a visible in-app control
- [x] **NAV-02**: Operator keeps the current project scope when switching dashboard views
- [ ] **NAV-03**: Operator can use the pixel dashboard in both single-project and all-project contexts

### Scene

- [ ] **SCENE-01**: Operator can see one stable scene entity for each worker session shown by the current dashboard
- [ ] **SCENE-02**: Operator can recognize session urgency in the pixel scene using the same underlying attention semantics as the current dashboard
- [ ] **SCENE-03**: Operator can pan and zoom the pixel scene without breaking access to controls or session details
- [ ] **SCENE-04**: Operator can select a session entity in the scene and keep that selection stable while live updates arrive

### Session Inspection

- [ ] **INSP-01**: Operator can inspect selected session details including summary, branch, issue context, and recent state
- [ ] **INSP-02**: Operator can inspect PR state for a selected session including review, CI, and merge readiness cues
- [ ] **INSP-03**: Operator can tell when session or PR information is stale, paused, or limited by current backend conditions

### Actions

- [ ] **ACT-01**: Operator can send a message to a selected session from the pixel dashboard
- [ ] **ACT-02**: Operator can kill a selected session from the pixel dashboard
- [ ] **ACT-03**: Operator can restore a restorable session from the pixel dashboard
- [ ] **ACT-04**: Operator can merge a merge-ready PR from the pixel dashboard

### Live State

- [x] **LIVE-01**: Operator sees live session status and activity changes in the pixel dashboard using the same session/event contract as the current dashboard
- [x] **LIVE-02**: Operator sees session additions and removals reflected in the pixel scene without needing a manual page refresh
- [ ] **LIVE-03**: Operator can trust that counts and core states shown in the pixel dashboard stay aligned with the legacy dashboard

### Experience

- [ ] **UX-01**: Operator can distinguish working, waiting, review-needed, merge-ready, and done sessions through clear visual cues in the pixel dashboard
- [ ] **UX-02**: Operator can access dense operational details through a non-canvas UI surface so the pixel scene stays readable
- [ ] **UX-03**: Operator can use the pixel dashboard on common desktop viewport sizes without the scene becoming unusable

## v2 Requirements

### Customization

- **CUST-01**: Operator can customize the pixel dashboard layout beyond the default scene structure
- **CUST-02**: Operator can choose alternate themes or art assets for the pixel dashboard

### Advanced Simulation

- **SIM-01**: Operator can see stable sub-agent visualization when the backend exposes durable sub-agent semantics
- **SIM-02**: Operator can use richer ambient simulation features such as optional sound or deeper office/world interactions

### Editing

- **EDIT-01**: Operator can edit and persist the scene layout through an in-app layout editor

## Out of Scope

| Feature | Reason |
|---------|--------|
| Replacing the legacy dashboard entirely | The project explicitly keeps both dashboards supported |
| Porting the full `pixel-agents` VS Code extension behavior | The target is the dashboard mode, not the extension host/editor workflow |
| Pixel-only backend contracts or event channels | Shared operational truth is required to keep both dashboards aligned |
| Full office/layout editor in the first release | It expands scope sharply and is not required for a usable parity-first dashboard |
| Theme marketplace or asset upload system | High complexity and low MVP value compared with workflow parity |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| NAV-01 | Phase 1 | Pending |
| NAV-02 | Phase 1 | Complete |
| NAV-03 | Phase 1 | Pending |
| SCENE-01 | Phase 2 | Pending |
| SCENE-02 | Phase 2 | Pending |
| SCENE-03 | Phase 2 | Pending |
| SCENE-04 | Phase 2 | Pending |
| INSP-01 | Phase 3 | Pending |
| INSP-02 | Phase 3 | Pending |
| INSP-03 | Phase 4 | Pending |
| ACT-01 | Phase 3 | Pending |
| ACT-02 | Phase 3 | Pending |
| ACT-03 | Phase 3 | Pending |
| ACT-04 | Phase 3 | Pending |
| LIVE-01 | Phase 1 | Complete |
| LIVE-02 | Phase 1 | Complete |
| LIVE-03 | Phase 4 | Pending |
| UX-01 | Phase 4 | Pending |
| UX-02 | Phase 3 | Pending |
| UX-03 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 20 total
- Mapped to phases: 20
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-14*
*Last updated: 2026-03-14 after initial definition*
