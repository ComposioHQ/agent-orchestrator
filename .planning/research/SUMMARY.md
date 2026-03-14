# Project Research Summary

**Project:** Agent Orchestrator Pixel Dashboard
**Domain:** brownfield operator dashboard with a second pixel-style 2D mode
**Researched:** 2026-03-14
**Confidence:** HIGH

## Executive Summary

This project is not a greenfield product and should not be treated like a game-engine rewrite. The research strongly supports keeping `agent-orchestrator`'s current web stack, server-side dashboard loader, SSE refresh model, and typed `DashboardSession` contract intact, then layering a second pixel-style renderer on top. The right model is "shared operational truth, divergent presentation," not "new dashboard, new backend shape."

The strongest value from `pixel-agents` is the spatial metaphor: characters as session entities, camera-driven navigation, ambient animation, and a scene-like dashboard that feels alive. The biggest risk is losing the practical operator behaviors that the current dashboard already solves well: attention prioritization, project filtering, PR/issue inspection, and direct actions. The MVP therefore needs a visible view switcher and core workflow parity before optional simulation features like layout editing or deeper office customization.

Research also highlights that the cleanest architecture is a client-side canvas island inside the existing Next.js app. React should continue to own fetched data, overlays, and actions; the pixel world should own only transient scene state, motion, selection, and rendering. This keeps the feature mergeable, maintainable, and aligned with the brownfield codebase.

## Key Findings

### Recommended Stack

The stack should stay anchored in the current `agent-orchestrator` web package: Next.js 15, React 19, TypeScript, Tailwind 4, existing API routes, and the current SSE/session refresh flow. The research does not support introducing a heavyweight rendering or state framework for v1. Native Canvas 2D is the right rendering surface because it matches the working `pixel-agents` approach while avoiding the complexity of Phaser, PixiJS, `react-konva`, or a second frontend app.

The most important stack decision is negative: do not add a parallel data model or a game-engine-oriented frontend architecture. Use the existing `packages/web/src/app/page.tsx`, `packages/web/src/hooks/useSessionEvents.ts`, `packages/web/src/lib/types.ts`, and `/api/sessions` + `/api/events` seam as the one source of operational truth. Only optional supporting libraries such as `clsx` for shared chrome or `pixelmatch` for screenshot diffing are justified, and even those are conditional.

**Core technologies:**
- Next.js App Router: shared SSR shell and dashboard routing — keeps both modes inside one web app
- React 19: control surfaces, overlays, and data boundaries — should wrap the canvas, not render the world
- Native Canvas 2D: pixel world rendering, camera movement, and animation — closest fit to the proven `pixel-agents` model

### Expected Features

The table stakes are clear: a visible switcher between legacy and pixel modes, live session presence, one visible entity per worker session, preserved attention-level semantics, project filtering, core operator actions, and detail inspection for PR/issue/session state. Without those, the new mode becomes a demo instead of a real dashboard.

The differentiators worth building are spatial urgency mapping, ambient agent-state visualization, camera shortcuts, and a click-to-focus inspect drawer that combines playfulness with operational density. The research strongly argues against shipping layout editing, extension-style host features, sound-heavy interactions, or separate pixel-only backends in the MVP.

**Must have (table stakes):**
- Visible in-app switcher between legacy and pixel dashboards
- Shared live session/event/action contract reused in both modes
- Core operator actions and project filtering preserved in the pixel mode

**Should have (competitive):**
- Spatial attention map driven by the existing urgency model
- Animated agent-state cues for working, blocked, waiting, and merge-ready sessions
- Camera shortcuts and inspect-driven navigation that make the world practical to use

**Defer (v2+):**
- Full office/layout editor
- Theme or asset customization
- Deep simulation features such as richer sub-agent visualization

### Architecture Approach

The recommended architecture is a shared server loader plus a shared live dashboard state hook feeding two renderers: the current DOM dashboard and a new pixel dashboard client component. A new dashboard shell layer should hold the mode switcher, top-level stats/banners, and shared action adapters, while the pixel renderer remains isolated under its own `engine/`, `model/`, and `overlays/` folders.

The canvas engine should adapt ideas from `pixel-agents` such as imperative world state, a render loop, and camera/selection handling, but it should not import the VS Code webview lifecycle, layout editor, or transcript-driven status heuristics. All operational truth still comes from `DashboardSession`, `GlobalPauseState`, and existing API routes.

**Major components:**
1. Shared dashboard data loader — prepares initial sessions, pause state, orchestrator links, and project scope for both modes
2. Shared live state layer — continues to own SSE updates and refresh semantics
3. Pixel renderer stack — maps sessions into world entities, renders the scene, and exposes selections/actions through overlays

### Critical Pitfalls

The biggest risk is shipping a visually impressive world that is weaker than the current dashboard in real operator use. The second is allowing pixel mode to fork the data model or action layer, which would create permanent divergence. The third is overloading the canvas with too much detail or too many features from `pixel-agents`, especially the layout editor and extension-host assumptions.

1. **Reskin instead of operational surface** — start from parity mapping, not from visuals
2. **Forked data model between dashboards** — keep one shared contract and derive world state client-side
3. **World-space clutter and trust loss** — keep dense details in a side panel, not floating over every entity
4. **Brownfield rendering thrash** — keep React as the data/control layer and the canvas as the motion/render layer
5. **Scope blow-up from layout editing** — defer editor and asset-system work until the dashboard mode proves value

## Implications for Roadmap

Based on the research, suggested phase structure:

### Phase 1: Shared Dashboard Foundation
**Rationale:** both dashboards must share one source of truth before any pixel-specific UI work is safe
**Delivers:** shared loader, shared action adapters, mode switcher seam, and normalized live-state consumption
**Addresses:** coexistence, parity foundation, and data-contract safety
**Avoids:** backend/UI drift between legacy and pixel modes

### Phase 2: Pixel World Core
**Rationale:** the scene only becomes useful once sessions, attention levels, and project scope are mapped into stable world entities
**Delivers:** pixel renderer, entity mapping, camera controls, selection model, and inspect drawer
**Uses:** native Canvas 2D and the current `DashboardSession` contract
**Implements:** world model, scene adapter, and canvas engine boundaries

### Phase 3: Core Workflow Parity
**Rationale:** the new mode must handle the real day-to-day actions that justify its existence
**Delivers:** send, kill, restore, merge, project filtering, done-session handling, PR/issue/session detail parity
**Uses:** existing action routes and current urgency semantics
**Implements:** operational overlays, inspector actions, parity verification

### Phase 4: Pixel Polish and Trust
**Rationale:** motion, scanability, trust markers, and performance should be refined after the operational baseline is stable
**Delivers:** ambient animation, stronger urgency cues, performance cleanup, accessibility fallback improvements, and explicit stale/pause/rate-limit signaling
**Uses:** learned behavior from the first usable version
**Implements:** UX polish without reopening core architecture

### Phase Ordering Rationale

- The shared data seam comes first because every later decision depends on not forking the dashboard contract.
- The world model comes before action parity because the renderer needs stable entities, selection, and spatial structure before operator workflows can be layered on top.
- Core workflow parity comes before aesthetic polish because this project is explicitly parity-first.
- Trust, performance, and accessibility deserve a dedicated phase because simulation-heavy UIs often regress there after the main build is "working."

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 2:** scene mapping and asset strategy may need deeper technical validation if the chosen world layout becomes complex
- **Phase 4:** accessibility and visual regression strategy for a canvas-heavy dashboard may need extra planning detail

Phases with standard patterns (skip research-phase):
- **Phase 1:** shared loader/action extraction is standard brownfield refactoring work inside the existing Next app
- **Phase 3:** wiring current actions and filters into a second renderer is mostly parity and integration work, not domain exploration

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | The brownfield stack is already known and the research consistently points toward keeping it |
| Features | HIGH | The current dashboard and the desired pixel metaphor together make MVP scope very legible |
| Architecture | HIGH | The shared-loader/shared-contract/second-renderer seam is clear in the current codebase |
| Pitfalls | HIGH | The major failure modes are strongly implied by both repos and by the parity-first goal |

**Overall confidence:** HIGH

### Gaps to Address

- World layout semantics: decide exactly how projects and attention zones map into the 2D plane during roadmap and phase planning
- Asset strategy: confirm the initial sprite/layout approach that is legal, lightweight, and repo-owned without inheriting `pixel-agents` licensing constraints

## Sources

### Primary (HIGH confidence)
- `agent-orchestrator/.planning/PROJECT.md` — project goals and constraints
- `agent-orchestrator/.planning/research/STACK.md` — stack recommendations and brownfield compatibility notes
- `agent-orchestrator/.planning/research/FEATURES.md` — MVP/table-stakes/differentiator analysis
- `agent-orchestrator/.planning/research/ARCHITECTURE.md` — shared-loader and pixel-renderer architecture proposal
- `agent-orchestrator/.planning/research/PITFALLS.md` — failure modes and recovery guidance

### Secondary (MEDIUM confidence)
- `pixel-agents/README.md` — directional guidance on the metaphor and asset constraints
- `pixel-agents/webview-ui/src/App.tsx` and `pixel-agents/webview-ui/src/office/components/OfficeCanvas.tsx` — practical reference for the scene/canvas approach

### Tertiary (LOW confidence)
- None needed beyond local repo evidence for this milestone definition

---
*Research completed: 2026-03-14*
*Ready for roadmap: yes*
