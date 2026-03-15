# Feature Research

**Domain:** brownfield operator dashboard with a second pixel-style 2D mode
**Researched:** 2026-03-14
**Confidence:** HIGH

## Feature Landscape

This is a subsequent-milestone feature set for `agent-orchestrator`, not a new product. The existing dashboard already provides the core operator contract through `packages/web/src/app/page.tsx`, `packages/web/src/components/Dashboard.tsx`, `packages/web/src/components/AttentionZone.tsx`, `packages/web/src/components/SessionCard.tsx`, `packages/web/src/app/api/sessions/route.ts`, and `packages/web/src/app/api/events/route.ts`. The pixel mode should reuse that contract and add a second renderer rather than fork behavior.

The local `pixel-agents` repo shows the useful parts of the metaphor in `pixel-agents/webview-ui/src/App.tsx`, `pixel-agents/webview-ui/src/office/components/OfficeCanvas.tsx`, `pixel-agents/webview-ui/src/office/engine/officeState.ts`, and `pixel-agents/webview-ui/src/hooks/useExtensionMessages.ts`: a spatial canvas, character-state visualization, camera/selection, and a persistent office model. It also shows where scope explodes when extension-specific workflows or layout editing become part of v1.

### Table Stakes (Users Expect These)

Features operators will expect before they will trust the new mode for daily use.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| In-app view switcher between legacy and pixel modes | `PROJECT.md` explicitly requires both dashboards to remain supported | LOW | Best seam is the existing web entry in `packages/web/src/app/page.tsx` with a shared session load and a client-side mode toggle in `packages/web/src/components/Dashboard.tsx` or a sibling wrapper |
| Live session presence and activity updates | Pixel mode is unusable if it lags behind the current SSE-driven dashboard | MEDIUM | Reuse `packages/web/src/hooks/useSessionEvents.ts` and `/api/events`; do not create a second polling/event protocol |
| One visible entity per worker session | Operators need to find every running worker immediately | MEDIUM | Map `DashboardSession.id` from `packages/web/src/lib/types.ts` to one character/card node in the 2D scene; orchestrator sessions can stay outside the main floor or in a separate control rail |
| Attention-state visibility inside the 2D scene | Current dashboard is organized around merge/respond/review/pending/working/done priorities | MEDIUM | Preserve `getAttentionLevel()` from `packages/web/src/lib/types.ts`; express it through zone placement, badges, and color-coded callouts rather than inventing a new prioritization model |
| Core operator actions from the scene | The current dashboard already supports send, kill, restore, and merge | MEDIUM | Keep action wiring to `packages/web/src/app/api/sessions/[id]/send/route.ts`, `packages/web/src/app/api/sessions/[id]/kill/route.ts`, `packages/web/src/app/api/sessions/[id]/restore/route.ts`, and `packages/web/src/app/api/prs/[id]/merge/route.ts` |
| Project filtering and all-project navigation | Multi-project scoping already exists and operators will expect it in both modes | LOW | Respect `?project=` behavior from `packages/web/src/components/ProjectSidebar.tsx`, `packages/web/src/app/page.tsx`, and `/api/sessions?project=...` |
| PR and issue context on selection | Operators need to understand why a session needs attention, not just that it exists | MEDIUM | Reuse session/PR fields already serialized in `packages/web/src/lib/serialize.ts` and `packages/web/src/lib/types.ts`; pixel mode can reveal them in a right panel, popover, or inspect drawer |
| Clear handling for done/terminal sessions | The current dashboard collapses done work and supports restore where appropriate | LOW | Keep terminal-state rules aligned with `TERMINAL_STATUSES`, `TERMINAL_ACTIVITIES`, and `NON_RESTORABLE_STATUSES` in `packages/web/src/lib/types.ts` |
| Fallback accessibility path | A canvas-only scene is risky in a brownfield web app | MEDIUM | Keep the legacy dashboard one click away and keep a DOM-based inspector/action panel for keyboard and narrow-screen use |

### Differentiators (Competitive Advantage)

These are the features that justify doing the pixel mode instead of a visual reskin.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Spatial attention map based on real dashboard priorities | Lets operators scan urgency by place, not just by list position | MEDIUM | Use attention zones from `packages/web/src/lib/types.ts` as physical neighborhoods or lanes; this is the cleanest bridge between `AttentionZone.tsx` and `pixel-agents`' office metaphor |
| Animated agent state as ambient telemetry | Operators can perceive "working vs blocked vs waiting" without opening every session card | MEDIUM | Borrow character-state rendering ideas from `pixel-agents/webview-ui/src/office/engine/officeState.ts` and `pixel-agents/webview-ui/src/office/components/OfficeCanvas.tsx`, but drive them from AO session/activity states instead of transcript heuristics |
| Click-to-focus inspect drawer | Combines playful spatial browsing with the practical detail density of the current dashboard | LOW | Selecting a character should open the same operational data currently shown in `packages/web/src/components/SessionCard.tsx` and detail views, including branch, issue, PR, alerts, and actions |
| Camera shortcuts to active or urgent work | Improves navigation once the number of sessions outgrows a card grid | LOW | Pixel-agents already supports camera follow/zoom/pan patterns in `OfficeCanvas.tsx`; AO can adapt that for "jump to merge-ready", "jump to needs input", and "focus selected session" |
| Optional world layout that communicates structure | The 2D mode can express project grouping or workflow lanes more clearly than a kanban | MEDIUM | Favor a mostly fixed, repo-owned layout for v1, with lightweight mapping of projects or attention states to regions; this preserves mergeability better than full editor support |
| Visual sub-status cues for PR readiness | A merge-ready or blocked state becomes obvious before reading text | LOW | Use overlays, desk props, speech bubbles, or icon halos inspired by `pixel-agents` instead of duplicating the entire PR table in world form |

### Anti-Features (Commonly Requested, Often Problematic)

These are the attractive ideas most likely to damage scope, reliability, or mergeability in this milestone.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Full office layout editor in v1 | `pixel-agents` has a rich editor and it looks like part of the fantasy | It introduces a second product inside the feature: asset management, persistence, undo/redo, collision rules, and support burden from `pixel-agents/webview-ui/src/office/editor/*` and layout serializers | Ship a fixed or lightly configurable layout first; defer editing until the view proves operationally useful |
| Pixel-perfect port of the VS Code extension | Reusing the full `pixel-agents` UI sounds faster on paper | The extension assumes VS Code message plumbing, workspace/terminal creation, and transcript-driven heuristics from `pixel-agents/src/*` and `webview-ui/src/hooks/useExtensionMessages.ts` that do not match AO's web contracts | Reuse the metaphor and canvas/runtime patterns, not the extension host architecture |
| Scene-only interaction with no side panel | A pure game-like experience sounds cleaner | Operators still need dense issue/PR/action details; hiding them behind repeated clicks makes the dashboard slower than the current web UI | Pair the scene with a DOM inspector or action rail that keeps real work efficient |
| Drag-and-drop reassigning sessions between desks/projects | The metaphor suggests "move the worker to another desk" | AO project membership and runtime state are not a simple seat assignment; this risks semantic confusion and backend churn | Use spatial grouping as visualization only in v1; keep project changes and restores on explicit controls |
| Sound-heavy notification design | `pixel-agents` includes chimes and it increases novelty | Browser audio creates annoyance, permission friction, and bad multi-tab behavior in a serious operator tool | Keep notification hooks optional and off by default, or defer entirely |
| Theme/asset upload system | It is appealing for community creativity | Asset pipelines, moderation, licensing, and rendering QA create broad merge surface for little MVP value | Keep v1 assets repo-owned and minimal; revisit only after core workflows are proven |
| Independent pixel-mode backend models | A separate API could optimize for the scene | Forking data contracts would guarantee long-term drift between legacy and pixel modes | Keep one session/action/event contract and build an adapter layer on top of `DashboardSession` |

## Feature Dependencies

```text
[Pixel mode route/switcher]
    └──requires──> [Shared session/event/action contract]
                       ├──requires──> [DashboardSession serialization]
                       └──requires──> [Existing session/pr APIs]

[2D world rendering]
    └──requires──> [Character/session mapping]
                       └──requires──> [Attention-level mapping]

[Scene selection + inspect drawer]
    ├──requires──> [2D world rendering]
    └──requires──> [Shared session/action contract]

[Project-aware world]
    └──requires──> [Existing project filter semantics]

[Animated status cues]
    └──enhances──> [2D world rendering]

[Layout editor]
    └──conflicts──> [Mergeable MVP scope]
```

### Dependency Notes

- **Pixel mode route/switcher requires the shared session/event/action contract:** the safest brownfield implementation is a second presentation layer over `packages/web/src/lib/types.ts`, `packages/web/src/hooks/useSessionEvents.ts`, and the existing API routes, not a new source of truth.
- **2D world rendering requires character/session mapping:** before animation or interaction matters, every `DashboardSession` needs deterministic placement and identity inside the scene.
- **Character/session mapping requires attention-level mapping:** without a preserved mapping from `getAttentionLevel()`, the pixel view stops reflecting the operational triage model that makes the current dashboard useful.
- **Scene selection + inspect drawer requires both rendering and the shared action contract:** clicking a sprite only matters if it exposes the same details and actions operators already use today.
- **Project-aware world requires existing project filter semantics:** the new mode should honor the same `project` query parameter and all-project behavior already implemented by `packages/web/src/app/page.tsx` and `packages/web/src/components/ProjectSidebar.tsx`.
- **Animated status cues enhance 2D rendering:** movement, bubbles, and overlays are differentiators, but only after the scene is already a truthful reflection of live session state.
- **Layout editor conflicts with mergeable MVP scope:** it touches too many borrowed `pixel-agents` systems at once and should not be coupled to the first release.

## MVP Definition

### Launch With (v1)

Minimum viable first release for the pixel dashboard.

- [ ] View switcher between legacy and pixel dashboards using the existing web entry points
- [ ] Shared live data flow using `packages/web/src/hooks/useSessionEvents.ts`, `/api/events`, and `/api/sessions`
- [ ] One scene entity per worker session with stable identity, project membership, and attention-level placement
- [ ] Basic camera controls: pan, zoom, and jump/focus to selected or urgent sessions
- [ ] Selection model that opens an inspect drawer/panel with session summary, branch, issue, PR state, and last activity
- [ ] Operator actions from the inspect surface: send message, kill, restore, merge PR
- [ ] Support for existing project filtering and all-project mode
- [ ] Clear treatment of done sessions, blocked sessions, and merge-ready sessions through consistent visual cues
- [ ] Responsive fallback where the scene coexists with conventional DOM controls instead of replacing them

### Add After Validation (v1.x)

- [ ] Better ambient animation vocabulary for active, blocked, waiting-input, and done states once the base mappings feel trustworthy
- [ ] Lightweight region customization or saved camera presets if operators need to tailor navigation
- [ ] Optional project-region layouts for teams using many concurrent sessions
- [ ] Observability overlays such as session count by zone or stale-session highlighting if operators ask for faster triage
- [ ] Optional notification polish, kept conservative and off by default

### Future Consideration (v2+)

- [ ] Layout editor and persistence modeled after `pixel-agents/webview-ui/src/office/editor/*` only after the dashboard proves daily utility
- [ ] Sub-agent visualization if AO exposes stable subagent semantics analogous to `pixel-agents`
- [ ] Theme/asset customization and richer office simulation
- [ ] Mobile-specific pixel dashboard treatment after the web version settles

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| View switcher + coexistence with legacy dashboard | HIGH | LOW | P1 |
| Shared live data contract for pixel mode | HIGH | MEDIUM | P1 |
| Character/session mapping in 2D scene | HIGH | MEDIUM | P1 |
| Inspect drawer with core details and actions | HIGH | MEDIUM | P1 |
| Project-aware filtering in pixel mode | HIGH | LOW | P1 |
| Animated status cues | MEDIUM | MEDIUM | P2 |
| Camera shortcuts for urgent work | MEDIUM | LOW | P2 |
| Lightweight world structure for projects or attention zones | MEDIUM | MEDIUM | P2 |
| Layout editing | LOW | HIGH | P3 |
| Theme or asset customization | LOW | HIGH | P3 |
| Sub-agent visualization | MEDIUM | HIGH | P3 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

## Competitor Feature Analysis

This milestone is better framed as "current AO dashboard vs pixel-agents metaphor" than as market competitor benchmarking.

| Feature | Current `agent-orchestrator` | Local `pixel-agents` repo | Recommended approach for this milestone |
|---------|------------------------------|---------------------------|----------------------------------------|
| Live operational truth | Strong: SSR load plus refresh/SSE via `packages/web/src/app/page.tsx`, `/api/sessions`, `/api/events`, and `useSessionEvents.ts` | Medium: strong local activity visualization, but extension-host-specific and heuristic-driven | Keep AO as source of truth and feed a pixel renderer from AO contracts |
| Triage model | Strong: explicit attention levels in `packages/web/src/lib/types.ts` and zone rendering in `AttentionZone.tsx` | Weak/implicit: status is visual, not organized around AO's merge/respond/review ordering | Make attention levels first-class spatial structure in the world |
| Operator actions | Strong: send, kill, restore, merge routes already exist | Medium: extension focuses more on spawn/focus/layout than AO-specific operations | Preserve AO actions; pixel mode should call existing APIs |
| Spatial navigation | Weak: grid/list layout only | Strong: camera, canvas, office state, and selection in `pixel-agents/webview-ui/src/office/components/OfficeCanvas.tsx` | Borrow spatial navigation patterns directly |
| Layout editing | Minimal in AO web dashboard | Strong but broad and extension-specific | Explicitly defer from MVP |

## Sources

- `agent-orchestrator/.planning/PROJECT.md`
- `agent-orchestrator/packages/web/src/app/page.tsx`
- `agent-orchestrator/packages/web/src/components/Dashboard.tsx`
- `agent-orchestrator/packages/web/src/components/AttentionZone.tsx`
- `agent-orchestrator/packages/web/src/components/SessionCard.tsx`
- `agent-orchestrator/packages/web/src/components/ProjectSidebar.tsx`
- `agent-orchestrator/packages/web/src/hooks/useSessionEvents.ts`
- `agent-orchestrator/packages/web/src/lib/types.ts`
- `agent-orchestrator/packages/web/src/lib/serialize.ts`
- `agent-orchestrator/packages/web/src/app/api/events/route.ts`
- `agent-orchestrator/packages/web/src/app/api/sessions/route.ts`
- `agent-orchestrator/packages/web/src/app/api/sessions/[id]/send/route.ts`
- `agent-orchestrator/packages/web/src/app/api/sessions/[id]/kill/route.ts`
- `agent-orchestrator/packages/web/src/app/api/sessions/[id]/restore/route.ts`
- `agent-orchestrator/packages/web/src/app/api/prs/[id]/merge/route.ts`
- `pixel-agents/README.md`
- `pixel-agents/webview-ui/src/App.tsx`
- `pixel-agents/webview-ui/src/office/components/OfficeCanvas.tsx`
- `pixel-agents/webview-ui/src/office/engine/officeState.ts`
- `pixel-agents/webview-ui/src/hooks/useExtensionMessages.ts`
- `pixel-agents/webview-ui/src/components/BottomToolbar.tsx`

---
*Feature research for: agent-orchestrator pixel dashboard*
*Researched: 2026-03-14*
