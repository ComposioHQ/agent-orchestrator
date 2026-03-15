# Phase 1: Shared Dashboard Foundation - Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Establish the shared dashboard shell and live data seam that let the legacy and pixel dashboards coexist without backend drift. This phase covers the visible mode switcher, URL/state behavior, project-scope continuity, and the shared shell structure for both modes. It does not build the full pixel world itself.

</domain>

<decisions>
## Implementation Decisions

### View switching
- Use a visible top-level toggle in the shared dashboard header to switch between legacy and pixel modes
- Treat the switcher as part of the main dashboard experience, not as a sidebar-only or hidden navigation element
- Keep the legacy dashboard as the default when no explicit view selection is present

### URL and state behavior
- Encode dashboard mode in the URL with a query param such as `?view=pixel`
- Preserve the existing `?project=` behavior when switching views
- Make the selected mode deep-linkable rather than keeping it only in local UI state

### Shared shell
- Keep a mostly shared dashboard shell across both modes
- Keep all important top-shell elements consistently visible in both modes: project title, status line, banners, and the mode switcher
- Swap the main dashboard body beneath the shared shell instead of giving the pixel mode a mostly separate page frame

### All-project behavior
- Support `project=all` in the pixel mode during Phase 1
- Represent all-project mode as one world with clearly separated project districts
- Make the project grouping visually obvious rather than subtle so operators can distinguish project boundaries at a glance

### Claude's Discretion
- Exact visual style of the header control, as long as it reads as a visible top toggle
- Exact naming of the query parameter values, as long as mode is URL-addressable and coexists cleanly with project scope
- Exact visual treatment used to separate project districts, as long as the grouping is immediately clear

</decisions>

<specifics>
## Specific Ideas

- The switcher should feel like part of the dashboard header, not like a separate navigation destination
- Pixel mode should be opt-in at first; the current legacy dashboard remains the stable default entry
- All-project mode should not collapse into a vague shared office; project districts should be clearly legible in Phase 1

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/web/src/app/page.tsx`: already loads the main dashboard payload server-side and is the natural seam for shared loader extraction and URL-backed mode selection
- `packages/web/src/components/ProjectSidebar.tsx`: already owns `?project=` navigation and establishes how project scope is reflected in the URL
- `packages/web/src/hooks/useSessionEvents.ts`: already provides the live session/global pause contract for both dashboard modes to share
- `packages/web/src/components/Dashboard.tsx`: already contains header-level status, banners, and action wiring that Phase 1 can factor into a shared shell

### Established Patterns
- The web app is a Next.js App Router app with server-loaded initial state and client-side SSE refresh
- `?project=` is already the canonical scoping mechanism; Phase 1 should extend URL semantics instead of replacing them
- Dashboard state is currently derived from `DashboardSession[]` plus `globalPause`, which supports a shared shell with divergent renderers beneath it

### Integration Points
- Mode selection should integrate at the page/shell level above the current `Dashboard` component
- URL updates must coexist with project filtering and current navigation behavior
- Live state for the pixel mode should flow from the same `/api/events` and `/api/sessions` path already used by the legacy dashboard

</code_context>

<deferred>
## Deferred Ideas

- The exact structure and motion of the pixel world itself belong to Phase 2
- Operator inspection/action parity belongs to Phase 3
- Richer customization, layout editing, and deeper simulation behavior remain out of scope for this phase

</deferred>

---
*Phase: 01-shared-dashboard-foundation*
*Context gathered: 2026-03-14*
