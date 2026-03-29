# Refactoring Improvements Roadmap — `packages/web/`

## Critical Refactors

### Refactor: Extract API Route Handler Middleware
- **Location**: `src/app/api/sessions/[id]/send/route.ts`, `kill/route.ts`, `restore/route.ts`, `message/route.ts`, `remap/route.ts`
- **Problem**: Every session action route repeats 30-40 lines of identical boilerplate: param extraction, session ID validation, service initialization, error mapping (SessionNotFoundError → 404), observability recording on success/failure. This violates DRY and means bug fixes must be applied in 5+ places.
- **Impact**: A validation or observability change requires touching 5-6 files. Inconsistencies have already crept in (`message/route.ts` uses nested try-catch while others use flat; `remap/route.ts` uses string-based error detection).
- **Suggested Approach**: Create a `withSessionAction` higher-order function in `src/lib/api-helpers.ts`:
  ```typescript
  export function withSessionAction(
    handler: (params: { session: Session; services: Services; correlationId: string; request: Request }) => Promise<Response>
  ): (request: Request, context: { params: { id: string } }) => Promise<Response> {
    return async (request, context) => {
      const correlationId = getCorrelationId(request);
      const startedAt = Date.now();
      const idError = validateIdentifier(context.params.id, "session id");
      if (idError) return jsonWithCorrelation({ error: idError }, { status: 400 }, correlationId);
      try {
        const services = await getServices();
        const session = await services.sessionManager.get(context.params.id);
        return await handler({ session, services, correlationId, request });
      } catch (err) {
        // Centralized error mapping...
      }
    };
  }
  ```
  Each route becomes 10-15 lines of business logic instead of 60-90 lines of boilerplate + logic.

### Refactor: Break Up DirectTerminal's 290-line useEffect
- **Location**: `src/components/DirectTerminal.tsx:221-510`
- **Problem**: A single `useEffect` handles 6 distinct concerns: dynamic imports, terminal creation, XDA/OSC handler registration, selection buffer management, keyboard event handling, WebSocket lifecycle (connect + reconnect + cleanup), and resize events. It's impossible to modify one concern without reading all 290 lines for context.
- **Impact**: Any bug in selection buffering, reconnection, or XDA handling requires understanding the entire effect. New developers cannot contribute to individual features without grasping the whole system.
- **Suggested Approach**: Extract into custom hooks:
  - `useXtermInstance(ref, theme, variant)` — creates terminal, loads addons, registers XDA/OSC handlers. Returns `{ terminal, fitAddon }`.
  - `useTerminalWebSocket(terminal, sessionId)` — manages WebSocket lifecycle with reconnection. Returns `{ ws, status, error }`.
  - `useSelectionBuffer(terminal)` — handles write buffering during active selection.
  - `useTerminalResize(terminal, fitAddon, ws, fullscreen)` — handles container resize and fullscreen transitions.

  The main component becomes a composition of these hooks, each testable in isolation.

### Refactor: Eliminate Mutation in enrichSessionPR
- **Location**: `src/lib/serialize.ts:123-271`
- **Problem**: `enrichSessionPR()` takes a `DashboardSession` and mutates its `.pr` property in-place (14 field assignments at lines 136-146, then again at 185-226). It also returns a boolean, creating a confusing dual-purpose API. The caller passes an object and must know it's been silently modified. Two nearly identical `PREnrichmentData` object literals are constructed at lines 241-253 and 257-269.
- **Impact**: Makes data flow hard to trace — callers can't tell from the function signature that their input is being modified. The duplicated cache-write object is a maintenance trap.
- **Suggested Approach**:
  1. Return the enriched PR object instead of mutating:
     ```typescript
     export async function enrichPR(pr: PRInfo, scm: SCM): Promise<DashboardPR | null>
     ```
  2. Extract the `PREnrichmentData` construction into a helper:
     ```typescript
     function toPREnrichmentData(pr: DashboardPR): PREnrichmentData { ... }
     ```
  3. Callers assign the result: `dashboard.pr = await enrichPR(core.pr, scm) ?? dashboard.pr`

### Refactor: Replace String-Based Error Detection in Remap Route
- **Location**: `src/app/api/sessions/[id]/remap/route.ts:52-56`
- **Problem**: Error routing depends on `msg.includes("not using the opencode agent")`. If the upstream error message changes (even a typo fix), this check silently breaks, returning 500 instead of 422 with no compile-time warning.
- **Impact**: Fragile error classification that could degrade UX with incorrect error codes after any upstream refactor.
- **Suggested Approach**: Define a typed error class in `@composio/ao-core`:
  ```typescript
  export class AgentMismatchError extends Error { ... }
  ```
  Then check `instanceof AgentMismatchError` instead of string matching. This is consistent with how `SessionNotFoundError` is already handled in other routes.

## Medium Priority Improvements

### Refactor: Split Dashboard.tsx into Focused Modules
- **Location**: `src/components/Dashboard.tsx` (1060 lines)
- **Problem**: Contains 7 components (`DashboardInner`, `OrchestratorControl`, `ProjectOverviewGrid`, `ProjectMetric`, `MobileActionStrip`, `StatusCards`, `BoardLegendItem`) in one file. `DashboardInner` manages 15+ state variables and 10+ effects.
- **Impact**: Slow to navigate, hard to review in PRs, impossible to lazy-load sub-components.
- **Suggested Approach**: Extract into `src/components/dashboard/` directory:
  - `DashboardInner.tsx` — main orchestration with reduced state (delegate to child hooks)
  - `OrchestratorControl.tsx` — orchestrator dropdown
  - `ProjectOverviewGrid.tsx` + `ProjectMetric.tsx` — project cards
  - `MobileActionStrip.tsx` — mobile priority pills
  - `StatusCards.tsx` — fleet/active/PRs/review stat cards
  - `BoardLegend.tsx` — legend items
  - `useDashboardState.ts` — custom hook extracting the 15 `useState` + 10 `useEffect` calls

### Refactor: Split SessionCard.tsx
- **Location**: `src/components/SessionCard.tsx` (807 lines)
- **Problem**: Two completely different render paths (done card vs active card) in one component. `getAlerts` builds complex alert arrays through long conditional chains. Inline SVGs are repeated.
- **Impact**: Any change to the "done" card risks breaking the "active" card and vice versa. The `getAlerts` logic is untestable without rendering the full component.
- **Suggested Approach**:
  - Extract `DoneSessionCard.tsx` and `ActiveSessionCard.tsx` as separate components
  - Extract `getAlerts(session, pr)` into `src/lib/session-alerts.ts` as a pure function (easily unit-testable)
  - Extract shared icons into an `Icons.tsx` module

### Refactor: Parallelize PR Enrichment in Sessions Route
- **Location**: `src/app/api/sessions/route.ts:96-114`
- **Problem**: PR enrichment runs sequentially in a for-loop: each PR waits for the previous one to complete (or timeout). With 20 sessions having PRs and a 1.5s per-PR timeout, this could block for 30 seconds.
- **Impact**: Dashboard load time scales linearly with the number of PRs, degrading UX as fleets grow.
- **Suggested Approach**: Use `Promise.allSettled` with `AbortController` per item:
  ```typescript
  const prPromises = workerSessions.map((core, i) => {
    if (!core.pr) return Promise.resolve();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), PER_PR_ENRICH_TIMEOUT_MS);
    return enrichSessionPR(dashboardSessions[i], scm, core.pr, { signal: controller.signal });
  });
  await settlesWithin(Promise.allSettled(prPromises), PR_ENRICH_TIMEOUT_MS);
  ```

### Refactor: Deduplicate SSE Snapshot Building
- **Location**: `src/app/api/events/route.ts:84-95` and `158-169`
- **Problem**: The snapshot object construction `{ type: "snapshot", correlationId, emittedAt, sessions: dashboardSessions.map(...) }` is copy-pasted in two places with identical mapping logic.
- **Impact**: Any change to snapshot shape must be applied in two places; divergence is likely.
- **Suggested Approach**: Extract a `buildSnapshotEvent(dashboardSessions, correlationId)` helper function and call it from both the initial send and the periodic poll.

### Refactor: Consolidate /send and /message Endpoints
- **Location**: `src/app/api/sessions/[id]/send/route.ts` and `src/app/api/sessions/[id]/message/route.ts`
- **Problem**: Both endpoints accept a JSON body with a `message` string, validate it, strip control chars, and send it to the session. They differ only in minor validation ordering and error handling style. `message/route.ts` has nested try-catch while `send/route.ts` uses flat structure.
- **Impact**: Two endpoints doing the same thing creates confusion about which to use. The Dashboard component uses `/send` while SessionDetail uses `/message`.
- **Suggested Approach**: Deprecate `/message` and migrate callers to `/send`. If backward compatibility is needed, have `/message` re-export `/send`'s handler.

### Refactor: Split services.ts (Service Init vs Backlog Poller)
- **Location**: `src/lib/services.ts` (410 lines)
- **Problem**: This file mixes two unrelated responsibilities: singleton service initialization (lines 1-98) and the entire backlog auto-claim polling system (lines 100-410, including `pollBacklog`, `labelIssuesForVerification`, `relabelReopenedIssues`, `getBacklogIssues`, `getVerifyIssues`).
- **Impact**: Modifying the backlog logic requires loading the entire service initialization context. The 130-line `pollBacklog` function handles 4 distinct workflows.
- **Suggested Approach**: Extract to `src/lib/backlog-poller.ts` with:
  - `startBacklogPoller(getServices)` — the poller loop
  - `pollBacklog(services)` — one poll cycle
  - `labelIssuesForVerification(sessions, config, registry)` — already a separate function, just needs its own file
  - `getBacklogIssues()` / `getVerifyIssues()` — dashboard data accessors

### Improvement: Add AbortController to settlesWithin
- **Location**: `src/app/api/sessions/route.ts:19-32`
- **Problem**: When the timeout wins the race, the original promise keeps running. SCM API calls (fetching PR state, CI checks, review status) continue consuming network resources and potentially counting against rate limits even though their results will be discarded.
- **Impact**: Wasted API quota during slow periods; potential rate-limit exhaustion from abandoned requests.
- **Suggested Approach**: Accept an optional `AbortController` parameter and abort the signal when the timeout fires:
  ```typescript
  async function settlesWithin(promise: Promise<unknown>, timeoutMs: number, controller?: AbortController): Promise<boolean> {
    const timeoutPromise = new Promise<boolean>((resolve) => {
      setTimeout(() => { controller?.abort(); resolve(false); }, timeoutMs);
    });
    return Promise.race([promise.then(() => true).catch(() => true), timeoutPromise]);
  }
  ```

## Nice-to-Have Enhancements

### Enhancement: Extract Shared SVG Icon Components
- **Location**: Throughout `Dashboard.tsx`, `SessionCard.tsx`, `SessionDetail.tsx`, `DirectTerminal.tsx`
- **Description**: The same SVG paths (close icon, chevron, external link arrow, warning circle, check mark) are repeated across 10+ files. A shared `src/components/icons/` module would eliminate ~200 lines of duplicated SVG markup.
- **Benefit**: Single source of truth for icons; easier to update; smaller bundle if icons are referenced rather than inlined.
- **Suggested Approach**: Create `src/components/icons.tsx` exporting named icon components like `CloseIcon`, `ChevronIcon`, `ExternalLinkIcon`, `WarningIcon`, `CheckIcon`.

### Enhancement: Fix Misleading Cache TTL Comments
- **Location**: `src/lib/cache.ts:6,108`
- **Description**: Comment at line 6 says "Default TTL: 60 seconds" but the actual default is `5 * 60_000` (5 minutes) at line 13. The `prCache` export at line 108 is documented as "60s TTL" but uses the default constructor.
- **Benefit**: Prevents confusion when developers reason about cache freshness.
- **Suggested Approach**: Update comments to match actual values: "Default TTL: 5 minutes".

### Enhancement: Push-Based SSE Instead of Polling
- **Location**: `src/app/api/events/route.ts:129-192`
- **Description**: The SSE endpoint polls `sessionManager.list()` every 5 seconds per connected client. With N clients, this creates N×12 session list calls per minute. A push-based EventEmitter in the session manager would allow a single poll (or file-watcher) to broadcast to all clients.
- **Benefit**: Reduces server load linearly with client count; enables sub-second update latency.
- **Suggested Approach**: Add an `EventEmitter` to `SessionManager` that fires `session:change` events. The SSE endpoint subscribes once per client and forwards events. This is a larger change that touches `@composio/ao-core` and should be planned as a separate initiative.

### Enhancement: CORS Hardening for Terminal WebSocket Server
- **Location**: `server/terminal-websocket.ts` (CORS handler)
- **Description**: The CORS handler falls back to `*` when no `Origin` header is present. While the terminal server is typically behind a reverse proxy, this permissive default could allow unintended cross-origin access.
- **Benefit**: Defense-in-depth; prevents cross-origin terminal access even if proxy misconfiguration occurs.
- **Suggested Approach**: Default to rejecting requests with no origin instead of allowing `*`. Add an explicit `ALLOWED_ORIGINS` environment variable for configuration.

### Enhancement: Type-Safe Cached PR Data in dashboard-page-data.ts
- **Location**: `src/lib/dashboard-page-data.ts:84-98`
- **Description**: Cached PR enrichment data is assigned to `dashboard.pr` fields via type casting without runtime validation. If the cache schema evolves, stale cached objects would be silently misinterpreted.
- **Benefit**: Prevents subtle bugs from cache schema drift.
- **Suggested Approach**: Use a lightweight runtime validator (e.g., a `isPREnrichmentData()` type guard) before applying cached data to dashboard objects.

### Enhancement: Structured Error Types for All API Routes
- **Location**: All `src/app/api/` routes
- **Description**: Most routes catch errors and check `instanceof SessionNotFoundError`. The `remap` route uses string matching. Other routes use generic `Error` with no structured type information.
- **Benefit**: Consistent, compile-time-safe error classification across all routes.
- **Suggested Approach**: Define an `ApiError` hierarchy in `@composio/ao-core` with status code mappings:
  ```typescript
  export class ApiError extends Error { readonly statusCode: number; }
  export class NotFoundError extends ApiError { statusCode = 404; }
  export class ConflictError extends ApiError { statusCode = 409; }
  export class ValidationError extends ApiError { statusCode = 422; }
  ```
  Routes catch `ApiError` and use `err.statusCode` directly, eliminating per-route error mapping.
