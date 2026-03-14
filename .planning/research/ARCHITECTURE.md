# Architecture Research

**Domain:** brownfield Next.js dashboard with an additional 2D pixel renderer
**Researched:** 2026-03-14
**Confidence:** HIGH

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            Next.js App Shell                                │
├──────────────────────────────────────────────────────────────────────────────┤
│  `packages/web/src/app/page.tsx`                                            │
│  SSR loader + dashboard mode selection + initial props                      │
├──────────────────────────────────────────────────────────────────────────────┤
│                         Shared Dashboard Data Layer                          │
├──────────────────────────────────────────────────────────────────────────────┤
│  `packages/web/src/lib/services.ts`                                         │
│  `packages/web/src/lib/serialize.ts`                                        │
│  `packages/web/src/lib/types.ts`                                            │
│  `packages/web/src/app/api/sessions/route.ts`                               │
│  `packages/web/src/app/api/events/route.ts`                                 │
│  `packages/web/src/hooks/useSessionEvents.ts`                               │
├──────────────────────────────────────────────────────────────────────────────┤
│                          Dashboard Mode Renderers                            │
├──────────────────────────────────────────────────────────────────────────────┤
│  Legacy DOM mode: `packages/web/src/components/Dashboard.tsx`               │
│  Pixel mode: new `packages/web/src/components/pixel-dashboard/*`            │
│  View switcher + shared action adapters live above both renderers           │
├──────────────────────────────────────────────────────────────────────────────┤
│                    Operator Actions and Session Mutations                    │
├──────────────────────────────────────────────────────────────────────────────┤
│  `.../api/sessions/[id]/send/route.ts`                                      │
│  `.../api/sessions/[id]/kill/route.ts`                                      │
│  `.../api/sessions/[id]/restore/route.ts`                                   │
│  `.../api/prs/[id]/merge/route.ts`                                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| Server page loader | Fetch initial sessions, global pause, orchestrators, and project selection | Keep in `packages/web/src/app/page.tsx`, but move data assembly into a shared loader helper before adding a second mode |
| Shared live session model | Own the canonical browser-side session/global pause state fed by SSE and refreshes | Evolve `packages/web/src/hooks/useSessionEvents.ts` into a mode-agnostic source for both dashboards |
| Renderer adapter | Map `DashboardSession` into renderer-specific entities, overlays, and selections | New client adapter under `packages/web/src/components/pixel-dashboard/model/` |
| Pixel renderer | Own canvas loop, camera, hit-testing, sprite/layout concerns, and simulation-only state | Keep imperative state outside React, following `pixel-agents/webview-ui/src/office/engine/officeState.ts` and `.../gameLoop.ts` |
| Operator action gateway | Expose send/kill/restore/merge from either dashboard without duplicating fetch logic | Shared action hooks/helpers consumed by both `Dashboard.tsx` and the new pixel controls |

## Recommended Project Structure

```
packages/web/src/
├── app/
│   └── page.tsx                          # SSR entrypoint + mode selection
├── components/
│   ├── dashboard-shell/                 # Shared controls visible in both modes
│   │   ├── DashboardModeSwitcher.tsx    # Legacy/pixel switcher
│   │   ├── DashboardHeader.tsx          # Title, stats, project, pause/rate limit banners
│   │   └── useDashboardActions.ts       # send/kill/restore/merge/spawn adapters
│   ├── legacy-dashboard/                # Existing DOM dashboard pieces
│   │   └── ...                          # move current `Dashboard.tsx` children gradually
│   └── pixel-dashboard/
│       ├── PixelDashboard.tsx           # client entrypoint for 2D mode
│       ├── PixelDashboardCanvas.tsx     # canvas host and DOM overlays
│       ├── engine/
│       │   ├── worldState.ts            # imperative sim/camera/entity state
│       │   ├── gameLoop.ts              # requestAnimationFrame loop
│       │   ├── renderer.ts              # draw world from worldState snapshot
│       │   └── interaction.ts           # hit testing, hover, selection
│       ├── model/
│       │   ├── sessionWorld.ts          # DashboardSession -> world entities
│       │   ├── layout.ts                # attention zones/project islands/spawn points
│       │   └── events.ts                # SSE patch application into world state
│       ├── assets/                      # sprite sheets, layout json, tiles
│       └── overlays/                    # action menus, tooltips, inspector panels
├── hooks/
│   └── useLiveDashboardState.ts         # extracted from `useSessionEvents.ts`
├── lib/
│   ├── dashboard-data.ts                # shared server loader output for both modes
│   ├── serialize.ts                     # existing core -> DashboardSession serializer
│   └── types.ts                         # canonical shared data contract
```

### Structure Rationale

- **`components/dashboard-shell/`:** the view switcher, header, banners, and action adapters should not live inside either renderer. This keeps the second mode additive instead of forking the page.
- **`components/pixel-dashboard/engine/`:** canvas state should be isolated from React render cadence. This matches the working split in `pixel-agents/webview-ui/src/office/components/OfficeCanvas.tsx` and `.../office/engine/gameLoop.ts`.
- **`components/pixel-dashboard/model/`:** world mapping logic should stay separate from drawing code. `DashboardSession` changes should produce new entity intents without directly mutating renderer internals all over the component tree.
- **`lib/dashboard-data.ts`:** extracting the page loader avoids duplicating the `page.tsx` fetch/enrichment sequence when more routes or search-param modes appear.

## Architectural Patterns

### Pattern 1: Shared Loader, Divergent Renderer

**What:** keep one server-side data contract and let each dashboard mode consume the same `DashboardSession[]`, `GlobalPauseState`, project info, and orchestrator links.
**When to use:** immediately. The current app already has the right seam in `packages/web/src/app/page.tsx` plus `packages/web/src/lib/serialize.ts`.
**Trade-offs:** lowest maintenance cost and easiest parity tracking, but it forces the pixel dashboard to accept the existing flattened session model instead of inventing a game-specific API.

**Example:**
```typescript
type DashboardPageData = {
  sessions: DashboardSession[];
  globalPause: GlobalPauseState | null;
  orchestrators: DashboardOrchestratorLink[];
};

export default async function Home() {
  const data = await loadDashboardPageData();
  const mode = resolveDashboardMode();

  return mode === "pixel" ? (
    <PixelDashboard {...data} />
  ) : (
    <Dashboard {...data} />
  );
}
```

### Pattern 2: React Owns Data, Engine Owns Motion

**What:** React should own fetched state, overlays, and action menus; the canvas engine should own interpolation, camera, hover, pathing, and per-frame rendering.
**When to use:** for the pixel renderer. `pixel-agents/webview-ui/src/App.tsx` already demonstrates that the imperative engine survives frequent message updates better than a React-only redraw loop.
**Trade-offs:** more plumbing between declarative props and imperative state, but avoids repainting the entire dashboard on every animation frame or SSE patch.

**Example:**
```typescript
function PixelDashboard({ sessions }: { sessions: DashboardSession[] }) {
  const worldRef = useRef<WorldState | null>(null);

  useEffect(() => {
    worldRef.current ??= new WorldState();
    worldRef.current.applySessions(mapSessionsToWorldEntities(sessions));
  }, [sessions]);

  return <PixelDashboardCanvas worldRef={worldRef} />;
}
```

### Pattern 3: Action Adapters Outside the Renderer

**What:** both dashboard modes should call the same fetch wrappers for `send`, `kill`, `restore`, `merge`, and orchestrator spawn instead of embedding route knowledge in UI widgets.
**When to use:** before building pixel interactions. Current logic is embedded in `packages/web/src/components/Dashboard.tsx`.
**Trade-offs:** small refactor up front, but it prevents the pixel dashboard from copying imperative fetch code and diverging in error handling.

**Example:**
```typescript
export function useDashboardActions() {
  return {
    send: (sessionId: string, message: string) =>
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, { method: "POST", body: ... }),
    kill: (sessionId: string) =>
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, { method: "POST" }),
    restore: (sessionId: string) =>
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, { method: "POST" }),
    merge: (prNumber: number) =>
      fetch(`/api/prs/${prNumber}/merge`, { method: "POST" }),
  };
}
```

## Data Flow

### Request Flow

```
[Page request with ?project=&mode=]
    ↓
`packages/web/src/app/page.tsx`
    ↓
`packages/web/src/lib/services.ts` + `packages/web/src/lib/serialize.ts`
    ↓
`DashboardSession[]` + `GlobalPauseState` + orchestrator links
    ↓
[Dashboard shell]
    ├── Legacy renderer (`components/Dashboard.tsx`)
    └── Pixel renderer (`components/pixel-dashboard/PixelDashboard.tsx`)
```

### State Management

```
`/api/events` SSE snapshots
    ↓
`useLiveDashboardState` reducer
    ├── lightweight field patches (`status`, `activity`, `lastActivityAt`)
    └── membership drift / staleness -> refresh `/api/sessions`
             ↓
       canonical React state
             ↓
   renderer adapter maps sessions -> world entities
             ↓
     imperative canvas/simulation state
             ↓
      operator selection / action overlays
             ↓
          shared action adapters
```

### Key Data Flows

1. **Initial load:** `packages/web/src/app/page.tsx` already assembles the full initial payload. Keep that as the authoritative first paint for both modes so the pixel dashboard does not boot from an empty canvas.
2. **Live updates:** `packages/web/src/hooks/useSessionEvents.ts` currently applies partial snapshot patches and falls back to `/api/sessions` when membership changes. Reuse that logic unchanged at the data layer; only the renderer adapter should translate updates into animations.
3. **Simulation state:** the pixel world should derive from `DashboardSession`, not store a second business-state copy. World state should only add view concerns such as coordinates, hover target, tween progress, path targets, and camera follow.
4. **Operator actions:** clicks in the canvas should select a session or PR entity, open a DOM overlay, and call the same endpoints used today: `send`, `kill`, `restore`, and `merge`.
5. **Refresh after mutations:** do not wait for optimistic local game logic to become canonical. After actions, rely on existing backend state transitions and the SSE + `/api/sessions` loop to reconcile the world.

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| Current operator-scale usage | Keep one Next.js app and one shared loader/state model. Canvas rendering is fine client-side. |
| More sessions per project | Optimize renderer-side culling and sprite batching before changing APIs. The SSE payload is already intentionally slim in `packages/web/src/app/api/events/route.ts`. |
| Many concurrent projects | Prefer route/query partitioning by project and optional lazy loading of pixel assets per mode. Avoid loading canvas assets when users stay in legacy mode. |

### Scaling Priorities

1. **First bottleneck:** renderer redraw cost, not the API. Fix with sprite caching, offscreen/precomputed tiles, and entity culling before reworking `/api/events`.
2. **Second bottleneck:** duplicate enrichment calls on refresh. If needed, further centralize loader logic around cached `serialize.ts` enrichment rather than adding pixel-specific data fetches.

## Anti-Patterns

### Anti-Pattern 1: Forking the Session Contract for Pixel Mode

**What people do:** create a new `/api/pixel-dashboard` shape with game-specific fields.
**Why it's wrong:** it splits parity work across two backend contracts and guarantees drift from `Dashboard.tsx`.
**Do this instead:** keep `packages/web/src/lib/types.ts` as the shared contract and build renderer-specific mapping code in `components/pixel-dashboard/model/`.

### Anti-Pattern 2: Letting the Canvas Engine Own Business Truth

**What people do:** store session status, PR mergeability, and action results directly inside engine classes as the source of truth.
**Why it's wrong:** SSE refreshes and route responses will fight imperative state, causing stale overlays and hard-to-reproduce bugs.
**Do this instead:** React owns canonical fetched state; the engine owns only presentational and simulation state.

### Anti-Pattern 3: Porting the VS Code Webview Whole

**What people do:** transplant `pixel-agents/webview-ui/src/App.tsx` and its VS Code message bridge into the Next.js app.
**Why it's wrong:** the webview code assumes extension host messages (`useExtensionMessages.ts`, `vscode.postMessage`) and editor-specific layout editing.
**Do this instead:** reuse the engine split, state shape ideas, and render loop from `pixel-agents`, but replace the transport layer with the existing Next.js loader/SSE/actions.

## Integration Points

### Reuse from `pixel-agents`

| Source | Reuse Pattern | Notes |
|--------|---------------|-------|
| `pixel-agents/webview-ui/src/office/engine/gameLoop.ts` | `requestAnimationFrame` loop | Safe to lift conceptually almost as-is; keep frame clamp and image smoothing rules. |
| `pixel-agents/webview-ui/src/office/engine/officeState.ts` | Imperative world/simulation container | Reuse the boundary pattern, not the office-specific seat/furniture model. Replace with session zones, entities, and camera state. |
| `pixel-agents/webview-ui/src/office/components/OfficeCanvas.tsx` | Canvas host + resize + input wiring | Good reference for separating DOM props from per-frame logic. |
| `pixel-agents/webview-ui/src/office/types.ts` | Strong typed world entities and tool/activity concepts | Useful for defining pixel-dashboard entity types, but should be reduced to dashboard needs. |
| `pixel-agents/webview-ui/src/hooks/useExtensionMessages.ts` | Transport adapter idea | Reuse only the adapter pattern: external updates feed a stable engine instance. Replace VS Code messages with `useLiveDashboardState`. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| `app/page.tsx` ↔ shared loader helper | direct function call | Extract current data assembly into `packages/web/src/lib/dashboard-data.ts` before adding pixel mode. |
| shared loader ↔ renderer modes | typed props | Both modes should receive the same page data shape. |
| `useLiveDashboardState` ↔ pixel engine adapter | React effect calling imperative methods | This is the key seam for animation without duplicating business logic. |
| pixel overlays ↔ action routes | shared fetch helpers/hooks | Must reuse current endpoints under `packages/web/src/app/api/sessions/*` and `packages/web/src/app/api/prs/*`. |
| pixel renderer ↔ existing app chrome | composition | Keep banners, project selection, and mode switcher in shared shell components, not inside the canvas. |

## Build Order Implications

1. Extract the current server page assembly in `packages/web/src/app/page.tsx` into a shared loader helper and add explicit dashboard mode selection.
2. Extract `Dashboard.tsx` action fetches into shared hooks/helpers so the legacy dashboard remains unchanged while the pixel mode can reuse them.
3. Rename or wrap `useSessionEvents.ts` into a mode-agnostic live-state hook consumed by both dashboards.
4. Build the pixel dashboard as a thin shell plus empty canvas renderer fed by real `DashboardSession[]`; verify initial load, project filtering, and SSE updates before adding richer simulation.
5. Add session/world mapping and overlays for the main operator actions first: inspect, send, kill, restore, merge.
6. Add higher-fidelity spatial behavior last: attention zones, project islands, motion interpolation, camera follow, sprite polish, and any `pixel-agents`-style layout theming.

## Sources

- Local project brief: `agent-orchestrator/.planning/PROJECT.md`
- Existing web app entrypoint: `agent-orchestrator/packages/web/src/app/page.tsx`
- Existing live update path: `agent-orchestrator/packages/web/src/hooks/useSessionEvents.ts`
- Existing SSE endpoint: `agent-orchestrator/packages/web/src/app/api/events/route.ts`
- Existing session API: `agent-orchestrator/packages/web/src/app/api/sessions/route.ts`
- Existing action routes: `agent-orchestrator/packages/web/src/app/api/sessions/[id]/send/route.ts`, `agent-orchestrator/packages/web/src/app/api/sessions/[id]/kill/route.ts`, `agent-orchestrator/packages/web/src/app/api/sessions/[id]/restore/route.ts`, `agent-orchestrator/packages/web/src/app/api/prs/[id]/merge/route.ts`
- Existing serializer and shared types: `agent-orchestrator/packages/web/src/lib/serialize.ts`, `agent-orchestrator/packages/web/src/lib/types.ts`
- Pixel renderer references: `pixel-agents/webview-ui/src/App.tsx`, `pixel-agents/webview-ui/src/office/components/OfficeCanvas.tsx`, `pixel-agents/webview-ui/src/office/engine/officeState.ts`, `pixel-agents/webview-ui/src/office/engine/gameLoop.ts`, `pixel-agents/webview-ui/src/hooks/useExtensionMessages.ts`

---
*Architecture research for: pixel-agents-style dashboard mode in existing `agent-orchestrator` web app*
*Researched: 2026-03-14*
