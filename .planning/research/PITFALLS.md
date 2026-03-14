# Pitfalls Research

**Domain:** brownfield Next.js operations dashboard adding a pixel-agents-style 2D mode
**Researched:** 2026-03-14
**Confidence:** HIGH

## Critical Pitfalls

### Pitfall 1: Treating the pixel dashboard as a reskin instead of an operational surface

**What goes wrong:**
Teams port the visual language from `pixel-agents` but drop the operator affordances that currently make `agent-orchestrator` usable: attention-zone prioritization, PR mergeability cues, restore/kill/send actions, global pause visibility, project scoping, and orchestrator entry points. The result demos well and fails real work.

**Why it happens:**
`pixel-agents` is optimized for spatial presence and simulation feedback in `pixel-agents/webview-ui/src/App.tsx` and `pixel-agents/webview-ui/src/office/components/OfficeCanvas.tsx`, while the current operator workflow is encoded in `agent-orchestrator/packages/web/src/components/Dashboard.tsx`, `.../AttentionZone.tsx`, and `.../SessionCard.tsx`. It is easy to copy the former and underweight the latter.

**How to avoid:**
Define parity from the existing web dashboard first, then map each workflow into the 2D world. The canonical source of urgency remains `agent-orchestrator/packages/web/src/lib/types.ts` and its `getAttentionLevel()` logic, not animation state. Require a path in the pixel mode for: view switching, project filtering, terminal drill-in, send, kill, restore, merge, PR inspection, and paused/rate-limited warnings.

**Warning signs:**
The pixel view can show agents moving but cannot answer "what should I do next?" within one glance or one click. Design reviews keep discussing charm, furniture, and motion more than merge/respond/review flows.

**Phase to address:**
Early architecture and parity-mapping phase before implementation starts.

---

### Pitfall 2: Forking the data model between legacy and pixel dashboards

**What goes wrong:**
The new mode introduces a separate session shape, event channel, or action layer. Legacy and pixel dashboards then disagree about counts, urgency, or available actions, and every backend change has to be implemented twice.

**Why it happens:**
The current dashboard already has a usable shared contract: SSR in `agent-orchestrator/packages/web/src/app/page.tsx`, live updates in `.../src/hooks/useSessionEvents.ts`, and typed UI semantics in `.../src/lib/types.ts`. A canvas-heavy rewrite creates pressure to bypass those seams and invent game-specific state.

**How to avoid:**
Keep one authoritative session/event/action contract for both modes. Add renderer-specific projection on top of `DashboardSession`, not parallel transport objects. If the pixel mode needs derived state such as room coordinates or avatar state, compute it client-side from the shared dashboard contract and keep those derivations disposable.

**Warning signs:**
New API routes appear just for pixel mode, or the pixel dashboard starts using fields that the legacy dashboard does not know about to determine urgency or action availability.

**Phase to address:**
Architecture and data-contract phase.

---

### Pitfall 3: Letting simulation heuristics override operational truth

**What goes wrong:**
Character motion, typing animations, or room placement become the perceived source of truth even when they are stale or inferred. Operators trust the avatar over the actual session state and make bad decisions.

**Why it happens:**
`pixel-agents` openly relies on heuristic status detection and observational syncing, as documented in `pixel-agents/README.md` and implemented through message-driven state in `pixel-agents/webview-ui/src/hooks/useExtensionMessages.ts`. `agent-orchestrator` already has stronger typed state for PRs, statuses, and attention levels.

**How to avoid:**
Treat the simulation as a visualization layer only. If a canvas element disagrees with `DashboardSession.status`, `DashboardSession.activity`, or `DashboardPR.mergeability`, the typed dashboard data wins. Surface uncertainty explicitly for stale PR data and membership refresh gaps rather than smoothing them away with animation.

**Warning signs:**
Specs describe avatars as indicating readiness or waiting state without referencing `getAttentionLevel()` or the actual session status source. Reviewers cannot explain what the operator should trust when motion and metadata diverge.

**Phase to address:**
Interaction-model and visual semantics phase.

---

### Pitfall 4: Breaking scanability by translating list UI directly into world-space clutter

**What goes wrong:**
Every badge, count, PR detail, and warning gets attached to avatars or floating UI. The screen becomes noisy, labels overlap, and operators lose the fast scan they currently get from grouped columns and tables.

**Why it happens:**
The existing dashboard deliberately compresses information with columns, counts, and expandable cards in `agent-orchestrator/packages/web/src/components/AttentionZone.tsx` and `.../SessionCard.tsx`. `pixel-agents` uses constant animated labels and overlay positioning in `pixel-agents/webview-ui/src/components/AgentLabels.tsx`, which does not scale cleanly to dense operational metadata.

**How to avoid:**
Reserve the world layer for coarse status, spatial grouping, and selection. Push dense details into anchored side panels, drawers, or inspector panes. Keep only a minimal set of persistent on-map markers: urgency, selection, and maybe project identity. Everything else should appear on focus, hover, or side inspection.

**Warning signs:**
Multiple avatars overlap with unreadable pills, or a designer needs zoomed-in screenshots to explain the state. Users can no longer scan 20-40 sessions faster than in the legacy view.

**Phase to address:**
UX mapping and early prototype validation phase.

---

### Pitfall 5: Collapsing multi-project semantics into a single decorative office

**What goes wrong:**
The pixel dashboard looks coherent for one project and becomes misleading for many. Agents from unrelated projects share space, filters are hidden, and project-specific orchestrators disappear into the art direction.

**Why it happens:**
Multi-project behavior is already a real concern in `agent-orchestrator`, documented in `agent-orchestrator/docs/specs/project-based-dashboard-architecture.md` and implemented in `.../src/app/page.tsx`, `.../src/components/ProjectSidebar.tsx`, and `.../src/hooks/useSessionEvents.ts`. `pixel-agents` assumes one office metaphor and one host context.

**How to avoid:**
Decide early whether the pixel view represents one project at a time, a campus of projects, or an all-project overview with separate zones. Preserve the current `project` scoping behavior end-to-end and make the visible switcher compatible with that scope instead of hiding it.

**Warning signs:**
The pixel mockups only make sense for a single project, or the "all projects" state is hand-waved as a later problem even though the current dashboard already supports it.

**Phase to address:**
Information architecture and routing phase.

---

### Pitfall 6: Reusing the `pixel-agents` editor/asset model when the feature only needs dashboard mode

**What goes wrong:**
The implementation inherits layout editing, furniture import, asset pipelines, and webview-era assumptions that are out of scope for this milestone. Delivery slows, and the new mode picks up maintenance burden with little operator value.

**Why it happens:**
`pixel-agents` includes editor state, furniture catalogs, asset loading, and custom layout persistence across files like `pixel-agents/webview-ui/src/office/editor/editorState.ts`, `.../layout/furnitureCatalog.ts`, and `pixel-agents/src/layoutPersistence.ts`. Those are central there, but the project brief explicitly says not to port the full extension/editor feature set.

**How to avoid:**
Lift only the minimum viable rendering and interaction ideas. Start with static or code-defined layouts for the dashboard mode. Defer layout editing and custom asset management unless they unlock a specific operator workflow in `agent-orchestrator`.

**Warning signs:**
New tasks start focusing on furniture import, export, office editing, or sprite catalog flexibility before core dashboard parity is working.

**Phase to address:**
Scoping and implementation slicing phase.

---

### Pitfall 7: Building a canvas loop that fights React and Next instead of coexisting with them

**What goes wrong:**
The new mode mixes imperative animation state with React render state in an ad hoc way, causing jank, hydration edge cases, or hard-to-debug stale closures once hooked into the existing Next app.

**Why it happens:**
The current web app is server-first Next.js in `agent-orchestrator/packages/web/src/app/page.tsx` with client updates through hooks. `pixel-agents` keeps game state outside React and drives rendering through `requestAnimationFrame` in `pixel-agents/webview-ui/src/office/engine/gameLoop.ts` and imperative `OfficeState` mutations in `.../officeState.ts`.

**How to avoid:**
Define a strict boundary: React owns data loading, controls, and inspectors; the pixel world owns only transient render state. Feed the canvas stable props derived from the shared dashboard store and avoid making React re-render on every animation frame. Keep SSR-safe mode switching so the page is still usable before the canvas hydrates.

**Warning signs:**
Frame updates start going through React state, or canvas internals begin fetching data and firing operational mutations directly instead of calling the existing action handlers.

**Phase to address:**
Rendering architecture phase.

---

### Pitfall 8: Hiding uncertainty and failures that operators currently see explicitly

**What goes wrong:**
Rate-limited PR data, paused orchestrators, reconnect lag, and stale membership changes are visually smoothed over. Operators think the system is current when it is not.

**Why it happens:**
The legacy dashboard already exposes uncertainty through banners and refresh logic in `agent-orchestrator/packages/web/src/components/Dashboard.tsx` and `.../src/hooks/useSessionEvents.ts`. Simulation UIs tend to reward continuity and can accidentally erase these explicit caveats.

**How to avoid:**
Carry the current trust markers into the new mode. Staleness, pause state, and data-quality warnings need dedicated UI outside the canvas, not just subtle avatar changes. If the SSE membership refresh path is still reconciling, show that state rather than pretending the world is settled.

**Warning signs:**
A user can no longer tell whether CI/review data is stale, or whether the orchestrator is paused, without leaving the pixel mode.

**Phase to address:**
Operator trust and status-indicator phase.

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Clone `Dashboard.tsx` into a pixel-specific page and diverge from shared handlers | Faster first demo | Two dashboards drift on send/kill/restore/merge behavior and banner logic | Only for a throwaway spike, never for merge-ready code |
| Create pixel-only API routes instead of reusing `packages/web/src/app/api/sessions`, `.../events`, and existing actions | Easier local experimentation | Contract drift, duplicated serialization, inconsistent counts | Never acceptable beyond a prototype branch |
| Port `pixel-agents` `OfficeState` wholesale into `agent-orchestrator` | Quick visual bootstrap | Imports editor-era assumptions, seat/layout complexity, and heuristic semantics the web app does not need | Acceptable only if heavily wrapped and trimmed to rendering concerns |
| Store world coordinates or avatar state as authoritative backend fields | Simplifies persistence for one mode | Locks the backend to one visualization and makes legacy parity harder | Acceptable only for optional user preferences, not operational truth |
| Put dense PR/session details into floating labels over the canvas | Makes screenshots look rich | Collisions, unreadable zoom states, inaccessible metadata | Never acceptable for primary detail presentation |
| Treat mode switch as a separate app instead of one dashboard with shared routing/state | Faster independent development | Old and new dashboards diverge in filters, deep links, and test coverage | Acceptable only if the seam still shares contracts and routing decisions |

## Integration Gotchas

Common mistakes when connecting the new mode to existing local systems.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| SSR page load in `packages/web/src/app/page.tsx` | Deferring all pixel-mode data loading to the client because canvas feels "app-like" | Keep server-loaded initial sessions and hydrate the pixel renderer from the same initial payload |
| SSE updates in `packages/web/src/hooks/useSessionEvents.ts` | Treating snapshot patches as enough for all UI state | Keep the existing membership-refresh behavior so add/remove events stay correct |
| Attention logic in `packages/web/src/lib/types.ts` | Re-deriving urgency from animation or PR snippets | Reuse `getAttentionLevel()` as the canonical action-priority mapping |
| Session actions in `/api/sessions/*` and `/api/prs/*` | Wiring canvas clicks directly to bespoke mutations | Call the same send/kill/restore/merge endpoints the legacy dashboard uses |
| Project scoping in `docs/specs/project-based-dashboard-architecture.md` | Applying filters only in the visible sidebar or camera view | Keep project scoping in SSR, SSE subscription, and action context together |
| Pixel asset/layout layer from `pixel-agents` | Assuming VS Code webview asset bootstrapping maps cleanly to Next static assets | Repackage only the assets actually needed and test loading under Next route/layout behavior |

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Re-rendering React on every animation frame | High CPU, input lag, inspector UI stutter | Keep animation state imperative inside the canvas loop and React updates event-driven | Breaks quickly on laptop hardware with 15-30 active avatars |
| Drawing full-world labels, badges, and effects every frame | Blurry clutter, dropped frames, thermal throttling | Limit persistent overlays, cull off-screen elements, and separate HUD from world rendering | Breaks once operators view multi-project or high-density rooms |
| Recomputing layout/pathfinding from live session updates | Frame spikes when sessions churn | Precompute static geometry and update only changed avatars | Breaks during bursts of agent creation/termination |
| Ignoring device-pixel-ratio and zoom costs | Sharpness issues on retina screens or oversized backing buffers | Explicitly budget canvas size and pixel density, following the disciplined resize logic seen in `pixel-agents/webview-ui/src/office/components/OfficeCanvas.tsx` | Breaks on high-DPI laptops and large monitors |
| Keeping all legacy dashboard tables mounted behind the pixel mode | Hidden work still consumes memory and CPU | Unmount inactive mode content or move shared data above mode-specific renderers | Breaks when both dashboards subscribe and render simultaneously |
| Polling or refetching aggressively to "help" the simulation feel live | Excess network traffic and redundant state churn | Reuse the existing SSE plus scheduled refresh cadence instead of adding a second live channel | Breaks in multi-tab usage and large repos with many sessions |

## Security Mistakes

Feature-specific issues beyond generic web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Exposing raw prompts, comments, or shell text as always-visible world labels | Sensitive data leaks into shared screens or screenshots | Keep world labels minimal and require explicit selection for detailed content |
| Using canvas hit targets as the only way to trigger destructive actions | Misclick-driven kill/merge/restore operations | Preserve explicit confirmation and action affordances similar to the current dashboard handlers |
| Importing third-party pixel assets casually into the product repo | Licensing and redistribution exposure | Track asset provenance carefully; `pixel-agents/README.md` already documents asset-license constraints |
| Letting project scoping become a front-end-only concern | Cross-project data leakage in multi-project views | Keep filtering in backend responses and SSE subscriptions, not just visual grouping |

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Prioritizing ambience over urgency | Operators enjoy the scene but miss merge/respond items | Make urgency visible at the room scale with a strong legend and side inspector |
| Making the 2D map the only navigation model | Users cannot jump fast to a session, PR, or terminal | Keep search, selection lists, or structured side panels alongside the world |
| Hiding core state behind hover-only affordances | Touch, keyboard, and low-precision input users lose access | Ensure every critical action/state has a persistent, focusable UI path |
| Using too many simultaneous motion cues | Attention gets pulled to movement instead of actionability | Reserve animation for real changes and urgent states, not constant decoration |
| Letting pixel-art labels determine readability | Session names, issue labels, and PR states become hard to scan | Use the pixel world for symbols and coarse grouping; render dense text in crisp UI chrome |
| Making old and new dashboards disagree on counts or labels | Trust in both modes collapses | Add explicit parity checks and compare top-level counts across modes during development |

## "Looks Done But Isn't" Checklist

- [ ] **Mode switcher:** Both modes exist, but project scope, deep links, and browser history do not stay aligned.
- [ ] **Pixel world:** Agents animate, but `send`, `kill`, `restore`, and `merge` are not all reachable from the new mode.
- [ ] **Parity:** Counts look plausible, but `getAttentionLevel()` results differ between legacy and pixel renderers.
- [ ] **Trust markers:** The pixel mode omits rate-limit, pause, reconnect, or stale-data indicators present in `packages/web/src/components/Dashboard.tsx`.
- [ ] **Accessibility:** Canvas is visually impressive, but keyboard navigation, focus order, and screen-reader equivalents are missing.
- [ ] **Performance:** The room feels smooth with 5 sessions, but frame rate collapses at realistic operator density.
- [ ] **Brownfield fit:** The canvas works in isolation, but Next hydration, route transitions, and multi-project state were not exercised.
- [ ] **Divergence control:** A feature ships in one dashboard mode without a policy for whether the other mode must match.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Reskin without parity | HIGH | Freeze visual expansion, inventory missing workflows against `Dashboard.tsx` and `SessionCard.tsx`, then backfill operator actions before adding more simulation features |
| Forked data contracts | HIGH | Collapse pixel-specific fetch/state back onto `DashboardSession`, `useSessionEvents()`, and existing API routes; add shared tests before resuming feature work |
| World-space clutter | MEDIUM | Move dense metadata into an inspector/sidebar, keep only urgency markers on the canvas, and rerun scanability tests with real session counts |
| React/canvas architecture thrash | HIGH | Draw a hard state boundary, remove per-frame React state updates, and profile the frame loop separately from dashboard controls |
| Multi-project ambiguity | MEDIUM | Reintroduce explicit project scoping in routing and UI, then validate one-project and all-project behavior side by side |
| Old/new dashboard drift | HIGH | Establish a parity checklist and snapshot tests for top-level counts/actions, then block further feature divergence until both modes agree |

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Reskin without operational parity | Phase 1: parity mapping and success criteria | Every legacy daily workflow is mapped to an explicit pixel-mode interaction |
| Forked data contracts | Phase 1: shared architecture seam definition | Pixel mode uses the same SSR payload, SSE hook, and action endpoints as legacy mode |
| Simulation overriding operational truth | Phase 2: state semantics and UI rules | Spec states that `DashboardSession` and `getAttentionLevel()` outrank avatar heuristics |
| World-space clutter and bad scanability | Phase 2: UX prototype and density validation | Operators can identify top-priority sessions at realistic counts faster than or equal to legacy |
| Multi-project collapse | Phase 2: routing and information architecture | Scoped and all-project views behave consistently across both modes |
| Canvas/React performance debt | Phase 3: rendering implementation | Profiling with realistic session counts shows stable interaction and acceptable frame times |
| Accessibility gaps in canvas-heavy UI | Phase 3: accessibility implementation | Keyboard/focus paths and non-canvas equivalents exist for core actions and status |
| Legacy/new dashboard divergence | Phase 4: verification and release hardening | Shared regression suite compares counts, actions, and warnings across both modes |

## Sources

- Local project brief in `agent-orchestrator/.planning/PROJECT.md`
- Current web dashboard implementation in `agent-orchestrator/packages/web/src/app/page.tsx`
- Live update and refresh behavior in `agent-orchestrator/packages/web/src/hooks/useSessionEvents.ts`
- Canonical dashboard semantics in `agent-orchestrator/packages/web/src/lib/types.ts`
- Current operator affordances in `agent-orchestrator/packages/web/src/components/Dashboard.tsx`
- Card/attention presentation in `agent-orchestrator/packages/web/src/components/AttentionZone.tsx` and `agent-orchestrator/packages/web/src/components/SessionCard.tsx`
- Existing project-scoping architecture in `agent-orchestrator/docs/specs/project-based-dashboard-architecture.md`
- Pixel-agents interaction model in `pixel-agents/webview-ui/src/App.tsx`
- Canvas/game-loop and imperative state patterns in `pixel-agents/webview-ui/src/office/components/OfficeCanvas.tsx`, `pixel-agents/webview-ui/src/office/engine/gameLoop.ts`, and `pixel-agents/webview-ui/src/office/engine/officeState.ts`
- Pixel-agents message/state integration in `pixel-agents/webview-ui/src/hooks/useExtensionMessages.ts`
- Pixel-agents label density and overlay behavior in `pixel-agents/webview-ui/src/components/AgentLabels.tsx`
- Pixel-agents known limitations and asset constraints in `pixel-agents/README.md`

---
*Pitfalls research for: Agent Orchestrator pixel dashboard subsequent milestone*
*Researched: 2026-03-14*
