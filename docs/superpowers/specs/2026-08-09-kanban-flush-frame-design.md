# Kanban Flush Frame Design

## Goal

Make the Kanban board surface meet the window at the top, right, and bottom edges while retaining the rounded left edge beside the sidebar.

## Scope

- Apply the treatment to the root and project Kanban routes when they render an actual board.
- Keep the first-run Welcome surface unchanged even though it shares the root route.
- Remove the center-panel shell inset on the top, right, and bottom.
- Preserve the existing top-left and bottom-left corner radius.
- Make the top-right and bottom-right corners square so the surface reaches the window edge cleanly.
- Retain the existing thin surface border on all four edges, including the flush edges.
- Do not change the Session, Orchestrator, Settings, Welcome, or standalone terminal surfaces.

## Implementation Boundary

The route shell will mark the Kanban frame explicitly. The shared center-panel CSS will use that modifier to override only the Kanban shell padding and surface corner radii. This avoids a content-dependent `:has()` selector and prevents other routes using `CenterPanelShell` from inheriting the treatment.

## Verification

- A component test will assert that only a Kanban-marked `CenterPanelShell` receives the modifier.
- A style contract test will assert zero top/right/bottom padding, retained left-side radii, square right-side corners, and no border removal.
- Existing CenterPanelShell, SessionsBoard, shell-route, and TypeScript checks will continue to pass.
