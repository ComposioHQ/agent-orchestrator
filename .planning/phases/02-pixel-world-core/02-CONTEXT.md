# Phase 2: Pixel World Core - Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Turn the current Phase 1 pixel preview into a real 2D world renderer that gives each worker session a stable place in the scene, expresses urgency through the world itself, supports bounded camera navigation, and maintains stable single-session selection during live updates. This phase does not add deeper inspection or action parity surfaces; it establishes the scene behavior those later phases will build on.

</domain>

<decisions>
## Implementation Decisions

### World layout
- In all-project mode, use fixed project districts with persistent coordinates rather than one undifferentiated shared map
- In single-project mode, show the same district model as a zoomed-in view, not a separate special-case map
- Within each project district, place sessions in stable attention neighborhoods based on their attention level
- Keep the world readable and spacious rather than busy or tightly packed
- Make district identity come primarily from structure and landmarks, not heavy per-project art theming

### Session entities
- Represent each worker session as a small agent-like sprite rather than a pure icon token or workstation prop
- Express urgency mainly through aura, ground rings, and nearby environmental cues rather than explicit status badges
- Use only subtle ambient idle motion so the world feels alive without becoming noisy
- Show session names in the world by default rather than hiding labels until hover/selection
- Move completed or terminal sessions into a quiet archive/done area inside the district instead of leaving them mixed into active work

### Camera behavior
- Open pixel mode framed to fit the current district or relevant all-project area rather than starting extremely wide or overly zoomed in
- Allow zooming, but clamp it to a bounded useful range
- Use direct drag-to-pan with no momentum or floaty inertial movement
- Only reframe automatically on explicit transitions such as project or mode changes, not on ordinary selection

### Selection behavior
- Clicking a session should highlight and pin it as selected without forcing an immediate camera recenter
- Selection is tied to session identity and should persist through live movement or layout updates
- Support single-select only in Phase 2
- If the selected session moves offscreen, keep it selected and show a locator cue instead of snapping the camera or clearing selection

### Claude's Discretion
- Exact district shapes, landmark vocabulary, and internal pathing geometry as long as districts remain structurally distinct and stable
- Exact sprite styling and animation loops as long as they stay readable and subtle
- Exact visual design of the offscreen locator cue and selection highlight
- Exact zoom clamps and pan limits as long as names and district structure remain legible

</decisions>

<specifics>
## Specific Ideas

- The Phase 1 district preview was only a temporary seam; Phase 2 should replace it with a real navigable world
- The world should feel spatial and intentional, but still scan like an operator surface rather than a toy
- Always-visible names matter enough that camera rules and density should protect readability instead of assuming labels can disappear
- Project districts should feel different because they are laid out differently, not because each one becomes a separate art theme

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/web/src/components/pixel-dashboard/PixelDashboardView.tsx`: current bounded pixel preview already groups by project and `AttentionLevel`, providing a temporary shape to replace
- `packages/web/src/lib/types.ts`: exposes `DashboardSession`, `AttentionLevel`, and `getAttentionLevel(...)`, which already define the semantic state the scene should visualize
- `packages/web/src/hooks/useSessionEvents.ts`: shared live contract already delivers membership churn and session updates for the pixel mode
- `packages/web/src/components/SessionCard.tsx`: existing urgency/readiness language can inform world-state mapping even though the card UI itself is not the Phase 2 target

### Established Patterns
- Phase 1 already locked a shared shell/body split, so Phase 2 should swap only the pixel body rather than reopen the shell architecture
- URL/project semantics are already canonicalized through dashboard route helpers and should remain untouched
- Attention semantics are already normalized into `merge`, `respond`, `review`, `pending`, `working`, and `done`, which makes neighborhood-based world layout natural

### Integration Points
- The new world renderer should live behind the existing pixel dashboard body seam in `packages/web/src/components/pixel-dashboard/`
- Selection state needs to coexist with shared shell chrome and future detail surfaces rather than inventing a second page frame
- Camera and scene state must consume the same shared dashboard payload and SSE refresh behavior already wired through Phase 1

</code_context>

<deferred>
## Deferred Ideas

- Deep inspection panels and richer session detail surfaces belong to Phase 3
- In-world session actions like send, kill, restore, and merge belong to Phase 3
- Trust/staleness markers and final visual polish belong to Phase 4
- Rich per-project art themes, office simulation, or layout customization remain out of scope for this phase

</deferred>

---
*Phase: 02-pixel-world-core*
*Context gathered: 2026-03-14*
