# Phase 2 Research: Pixel World Core

## Goal

Turn the Phase 1 pixel preview into a usable 2D scene that preserves one stable world entity per dashboard session, maps the existing attention semantics into readable world cues, supports bounded pan/zoom, and keeps single-session selection stable while live updates arrive.

This phase should satisfy:
- `SCENE-01`
- `SCENE-02`
- `SCENE-03`
- `SCENE-04`

This phase should not add detail panes or in-world action parity. It should establish the scene model and interaction contract those later phases will reuse.

## Current Implementation Snapshot

### Existing seams we should preserve

- `packages/web/src/components/Dashboard.tsx`
  - Already owns the canonical client-side session list through `useSessionEvents(...)`.
  - Already derives reusable groupings:
    - `sessionsByProject`
    - attention counts via `getAttentionLevel(...)`
    - `allProjectsView`
- `packages/web/src/components/dashboard-shell/DashboardShell.tsx`
  - Already keeps controls, banners, and mode switching outside the pixel body.
  - Phase 2 should keep scene interaction inside the body so shell controls remain accessible.
- `packages/web/src/components/pixel-dashboard/PixelDashboardView.tsx`
  - Currently a static Phase 1 preview.
  - This is the intended replacement seam for the real world renderer.
- `packages/web/src/hooks/useSessionEvents.ts`
  - Already gives the correct live contract for both steady-state activity updates and membership churn.
  - Important constraint: membership refreshes dispatch a full `reset`, replacing the session array.
- `packages/web/src/lib/types.ts`
  - `DashboardSession.id` is the stable identity anchor.
  - `getAttentionLevel(...)` is already the canonical urgency mapping.
  - `DashboardPayload` and `SSESnapshotEvent` are already view-safe and should stay shared.

### Important observations from the code

- There is no scene/rendering library in `packages/web/package.json` today.
- The current pixel mode is plain React + Tailwind, not canvas-based.
- `useSessionEvents` preserves ids but not object identity across refreshes. Any scene state stored against full session objects will be brittle.
- The SSE `snapshot` patch only updates `status`, `activity`, and `lastActivityAt`. Membership changes trigger a fetch to `/api/sessions?...&view=pixel`, which fully replaces `sessions`.
- The shared shell already solves the Phase 1 requirement that controls and banners stay outside the renderer. Phase 2 should not reopen that architecture.

## What Planning Must Account For

### 1. Stable scene behavior must be derived from ids, not array order or object identity

`useSessionEvents` can replace the entire session array during refresh. The scene must therefore treat:
- `session.id` as the entity key
- `projectId + attentionLevel` as current placement inputs
- local UI state like selection, camera focus hints, and offscreen cue state as id-based state

If planning stores `selectedSession` or cached positions keyed by object reference, `SCENE-04` will regress on the first membership refresh.

### 2. The world layout should be deterministic, not physics-driven

The phase context wants fixed districts, stable neighborhoods, and subtle motion. That argues for a deterministic layout pipeline:
- fixed district anchors per project
- fixed neighborhood anchors per attention zone
- stable slot assignment per session id within each neighborhood
- optional small idle animation layered on top of the stable base position

That is a better match than force-layout, collision simulation, or anything that continuously re-solves the scene.

### 3. Single-project mode should reuse the same world model, not fork layout logic

The context explicitly says single-project mode is the same district model zoomed in. Planning should avoid:
- separate renderers
- separate coordinate systems
- separate neighborhood rules

Instead:
- build one world model for all visible projects
- in single-project mode, render the same district schema with different initial camera framing and possibly hidden neighboring districts

### 4. Always-visible labels make density and camera rules a planning concern

The scene is expected to show session names by default. That means:
- district density must stay conservative
- zoom-out clamp must preserve label legibility
- session slots need consistent spacing
- the scene cannot rely on hover-only labels to stay readable

This strongly favors a modest number of absolute-positioned entities over a denser sprite swarm.

### 5. Selection must be independent from camera recentering

`SCENE-04` requires stable selection, but the context explicitly rejects automatic recentering on ordinary selection. Planning should separate:
- `selectedSessionId`
- camera viewport state
- offscreen indicator computation

Selection changes should only affect highlight state and offscreen locator state unless the operator explicitly chooses a refocus action later.

## Standard Stack

- React 19 client components for scene composition
- Existing `Dashboard` + `DashboardShell` ownership for shell chrome and live data
- Existing `useSessionEvents(...)` as the only live state source
- Existing `DashboardSession` / `getAttentionLevel(...)` types and semantics from `packages/web/src/lib/types.ts`
- CSS transforms plus absolute-positioned HTML elements inside a bounded viewport for Phase 2 rendering
- Small pure TypeScript scene helpers for:
  - world layout derivation
  - session slot assignment
  - camera clamping
  - offscreen indicator math
- Vitest + Testing Library for scene/model/unit coverage in `packages/web/src`

### Recommended renderer choice

Use DOM-based rendering for Phase 2, not a new canvas/game library.

Why:
- No graphics stack exists in the repo yet.
- The phase needs readable always-visible labels and stable operator interactions more than high-entity-count animation.
- DOM rendering integrates cleanly with current testing, CSS, accessibility, and the shared shell.
- The phase scope is scene behavior, not advanced rendering performance.

Canvas or Pixi-style rendering only becomes justified if later phases prove the DOM approach cannot handle real dashboard scale.

## Architecture Patterns

### Pattern 1: Split model, viewport, and presentation

Planning should separate three concerns:

1. Scene model derivation
   - Input: visible sessions, projects, current scope
   - Output: deterministic districts, neighborhoods, entity base positions, label text, urgency presentation state

2. Viewport/camera state
   - Input: container size, drag/wheel interaction, selected session id
   - Output: `pan`, `zoom`, viewport bounds, offscreen locator geometry

3. Presentation layer
   - Input: world model + camera transform + selected id
   - Output: React DOM nodes

This keeps the important behavior testable without a browser layout dependency.

### Pattern 2: Deterministic district layout

Use fixed district coordinates in world space.

Recommended rule:
- In all-project mode, derive district order from the current `projects` list when available, otherwise from sorted visible `projectId`s.
- Assign each district a fixed rectangle in world coordinates.
- Keep those rectangles stable regardless of live session count.

This avoids whole-world reflow when one project gains or loses a worker.

### Pattern 3: Stable neighborhood slots

Within each district, assign one anchor area per attention level:
- `merge`
- `respond`
- `review`
- `pending`
- `working`
- `done`

Recommended slot rule:
- Sort sessions within a neighborhood by a stable key:
  - `createdAt` if trustworthy
  - then `id` as the tiebreaker
- Map sorted sessions onto a predetermined slot grid or lane path.
- Keep the slot geometry fixed; only occupancy changes.

This satisfies `SCENE-01` more reliably than calculating positions from transient counts every render.

### Pattern 4: Hoist selection state above the pixel body

Even though Phase 2 does not yet need the inspection surface, planning should anticipate Phase 3.

Recommended ownership:
- `Dashboard.tsx` owns `selectedSessionId: string | null`
- `PixelDashboardView` receives:
  - `selectedSessionId`
  - `onSelectSession(id)`

Why:
- Later non-canvas details/actions will likely sit beside the scene, not inside it.
- Hoisting avoids a second refactor when Phase 3 adds detail panels.

### Pattern 5: Keep camera state local to pixel mode

`pan`, `zoom`, drag state, and viewport measurements should stay inside the pixel scene subtree.

Why:
- They are renderer-specific
- They do not belong in the shared shell
- They should reset only on explicit mode/scope transitions, not on session updates

## Don't Hand-Roll

- Do not build a physics simulation or force-directed layout.
- Do not build a custom canvas/game-engine abstraction layer in this phase.
- Do not invent a pixel-only backend contract or new SSE event type.
- Do not keep mutable scene entities in a long-lived imperative store when a deterministic world model will do.
- Do not store selection as a `DashboardSession` object reference.
- Do not couple selection changes to automatic camera recentering.
- Do not create separate all-project and single-project layout algorithms.

## Common Pitfalls

### Pitfall 1: World position drift on every refresh

If positions are recomputed from current array order or compacted to fill empty slots every render, sessions will appear to jump. Planning should require:
- fixed district rectangles
- fixed neighborhood slot geometry
- stable sort keys

### Pitfall 2: Resetting local scene state when `sessions` changes

`useSessionEvents` intentionally replaces the session array on membership refresh. Any effect that says "when sessions change, reset camera or selection" will break the phase goal.

Only reset camera framing on:
- project scope change
- dashboard mode transition into pixel mode

Do not reset on ordinary session updates.

### Pitfall 3: Letting "done" sessions crowd active areas

The context wants a quiet archive/done area. If planning keeps `done` in the same active lanes, the world will get noisy and hide urgent work.

### Pitfall 4: Over-animating the scene

The context wants subtle ambient motion. Animating entity paths continuously will make selection and urgency cues harder to read. Limit motion to:
- tiny sprite bob/idle loops
- low-amplitude aura pulses for urgency
- smooth camera transform updates only when the operator drags/zooms

### Pitfall 5: Building offscreen selection as a camera side effect

The correct behavior is:
- selection remains active
- camera stays where the operator left it
- a locator cue points toward the selected entity if it leaves the viewport

If the implementation instead snaps the camera or clears selection, `SCENE-04` fails.

## Code Examples

### Recommended world-model boundary

```ts
interface WorldModel {
  districts: DistrictModel[];
  sessions: SessionEntityModel[];
}

interface SessionEntityModel {
  id: string;
  projectId: string;
  attentionLevel: AttentionLevel;
  basePosition: { x: number; y: number };
  label: string;
  isArchived: boolean;
}

function buildWorldModel(input: {
  projects: ProjectInfo[];
  sessions: DashboardSession[];
  allProjectsView: boolean;
}): WorldModel
```

The important planning point is that `buildWorldModel(...)` should be a pure function with deterministic output for the same inputs.

### Recommended selection model

```ts
const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

const selectedSession =
  selectedSessionId === null
    ? null
    : sessions.find((session) => session.id === selectedSessionId) ?? null;
```

Persist the id, not the object.

### Recommended camera model

```ts
interface CameraState {
  panX: number;
  panY: number;
  zoom: number;
}

function clampCamera(
  camera: CameraState,
  worldBounds: Rect,
  viewportBounds: Size,
): CameraState
```

Camera math should be pure and testable. Pointer handlers can remain thin wrappers around it.

## Concrete File Seams For Planning

Recommended implementation split under `packages/web/src/components/pixel-dashboard/`:

- `PixelDashboardView.tsx`
  - scene container/composition only
- `PixelWorldScene.tsx`
  - viewport, drag/zoom wiring, transform application
- `scene-model.ts`
  - district and session entity derivation
- `camera.ts`
  - zoom clamps, pan bounds, visible-rect math
- `selection.ts`
  - selected entity lookup and offscreen indicator helpers
- `SessionSprite.tsx`
  - session entity rendering
- `ProjectDistrict.tsx`
  - district landmarks/neighborhood containers

Planning does not need all of these as separate plans, but it should preserve the model/viewport/presentation split.

## Validation Architecture

Validation for this phase should prove scene stability under live updates, not just that something pixel-styled renders.

### Unit-level validation

- `scene-model` tests
  - one entity is produced for every visible `DashboardSession`
  - the same input yields the same district/session positions
  - sessions moving between attention levels change neighborhoods without changing identity
  - `done` sessions route into the archive area
- `camera` tests
  - zoom is clamped to the defined min/max
  - panning is clamped to world bounds
  - project/mode transition framing computes a valid initial camera
- `selection` tests
  - selection persists when the backing session object instance changes
  - selection clears only when the selected id disappears from the visible session list
  - offscreen locator geometry is produced when the selected entity leaves the viewport
- `getAttentionLevel(...)` usage tests
  - scene urgency styling is keyed from existing attention semantics, not duplicated ad hoc status logic

### Component-level validation

- Pixel view renders one clickable entity per session
- entity labels are visible by default
- clicking an entity marks it selected
- selection styling survives a rerender with refreshed session objects
- wheel zoom and drag-pan update the world transform without affecting shell controls
- all-project mode renders multiple stable districts
- single-project mode renders the same district model with different framing

### Live-contract validation

Extend `useSessionEvents`-driven tests rather than creating a pixel-only event harness.

Critical assertions:
- snapshot updates change scene urgency/state without clearing selection
- membership refresh via `/api/sessions?...&view=pixel` preserves pixel view mode
- membership refresh does not reset camera or selection for surviving ids
- removed selected session ids are handled explicitly and predictably

### Manual verification targets

- Enter pixel mode from all-project view and confirm district positions do not shift when one project receives a new session
- Select a session, then trigger a live update that changes its status and verify the selection highlight remains
- Pan away from the selected entity and verify the locator cue appears instead of camera snap
- Switch between all-project and single-project pixel views and verify the camera reframes only on the scope transition

## Suggested Deliverables From Planning

The planning output should likely split into two implementation plans:

1. Scene model and renderer skeleton
   - replace the Phase 1 preview
   - deterministic district/session layout
   - urgency visuals
   - DOM scene rendering

2. Camera and selection behavior
   - bounded pan/zoom
   - stable selected-session id ownership
   - offscreen locator behavior
   - test coverage for refresh stability

That split matches the main technical risk boundary: world derivation first, interaction stability second.
