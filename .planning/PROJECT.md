# Agent Orchestrator Pixel Dashboard

## What This Is

This project adds a second dashboard mode to `agent-orchestrator`: a 2D game-like pixel dashboard inspired directly by `pixel-agents`, while preserving the existing dashboard as a supported view. It is for operators supervising multiple AI coding agents who want the same operational visibility and actions they already have today, but through a more spatial, expressive interface with an in-app view switcher.

## Core Value

Operators can use a pixel-style dashboard without losing the core workflows they rely on in the current dashboard.

## Requirements

### Validated

- ✓ Agent Orchestrator can manage AI coding sessions through a shared core plus plugin architecture — existing
- ✓ Agent Orchestrator already provides a web dashboard with live session state, project filtering, PR visibility, and operator actions — existing
- ✓ Agent Orchestrator already supports multiple integration surfaces including CLI, web APIs, and plugin-driven runtime/SCM/tracker/notifier layers — existing

### Active

- [ ] Add a visible in-app switcher so users can move between the legacy dashboard and the new pixel dashboard mode
- [ ] Build a pixel-style 2D dashboard view that adapts the `pixel-agents` spatial metaphor to `agent-orchestrator`
- [ ] Reach core workflow parity in the pixel dashboard for the main daily operator tasks currently supported by the existing dashboard
- [ ] Reuse the current dashboard data model, SSE updates, and operational actions so both dashboard modes stay aligned
- [ ] Define how current dashboard concepts such as attention zones, project filters, PR state, and session actions map into the 2D world

### Out of Scope

- Replacing the current root dashboard outright — both dashboards need to remain supported
- Porting the full `pixel-agents` VS Code extension/editor feature set — the goal is the dashboard experience, not the extension-specific editing workflow
- Treating the pixel dashboard as a visual demo without operational usefulness — parity-first is the agreed direction

## Context

`agent-orchestrator` is a brownfield pnpm monorepo centered on `packages/core`, with typed plugin slots for runtime, agent, workspace, tracker, SCM, notifier, and terminal integrations. The current web dashboard lives in `packages/web`, uses Next.js 15 with React 19, loads typed session data on the server in `packages/web/src/app/page.tsx`, and keeps it live through `packages/web/src/hooks/useSessionEvents.ts` plus `/api/events` and `/api/sessions`.

The current dashboard is operationally rich but document-style: session lists, attention zones, PR tables, project filtering, and direct actions such as send, kill, restore, and merge. The desired new dashboard is not just a reskin. It should adopt the exact 2D game-like plane direction from `pixel-agents`, but it must still work as a real operator surface and coexist with the existing dashboard.

From the earlier exploration, the cleanest merge-friendly seam is to keep a shared data contract and live update layer, then add a second renderer and route or view mode on top. The first milestone is not total feature parity, but a usable pixel dashboard with a visible switcher and coverage of the current dashboard's main daily workflows.

## Constraints

- **Brownfield**: Must fit the existing `agent-orchestrator` architecture — the repo already has established packages, APIs, and dashboard behavior
- **Compatibility**: The current dashboard must remain intact and supported — this work adds a second mode, not a breaking replacement
- **Parity**: The pixel dashboard must preserve core operator usefulness — visual novelty alone is not sufficient
- **UI Direction**: The new dashboard should use the `pixel-agents` 2D spatial metaphor directly — the project is not aiming for a mild stylistic inspiration
- **Shared Data Layer**: Both dashboards should stay on the same session/event/action contracts where possible — forked backend behavior would make the feature harder to maintain

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Keep the legacy dashboard and add a second supported dashboard mode | This is the safest path for mergeability and avoids breaking current users | — Pending |
| Prioritize workflow parity over a visual demo | The new dashboard must be usable for real orchestration work, not just impressive-looking | — Pending |
| Include a visible in-app view switcher in v1 | Users need an explicit way to choose between views while both remain supported | — Pending |
| Use the pixel-agents-style 2D game plane as the target interaction model | The goal is to bring over the strong spatial metaphor, not just cosmetic details | — Pending |
| Treat “v1 done” as switcher plus core parity, not near-total parity | This creates a realistic first milestone without weakening the product direction | — Pending |

---
*Last updated: 2026-03-14 after initialization*
