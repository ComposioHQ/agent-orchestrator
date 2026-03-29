# Code Quality Audit Report — `packages/web/`

## Executive Summary
- **Overall Score**: 672/1000
- **Maintainability Verdict**: Maintainable — solid foundations with targeted refactoring needed
- **Primary Strengths**: Strong type safety, comprehensive input validation, good mobile responsiveness, consistent observability pattern, clean separation of server vs. client code
- **Critical Weaknesses**: Significant API route handler boilerplate duplication, 800+ line god components, mutable shared state in serialization layer, overly permissive CORS in terminal server, and timeout-based promise racing that leaks pending promises

## File/Component Scores

| File/Path | Score /100 | Assessment |
|-----------|------------|------------|
| `src/lib/types.ts` | 92 | Clean type definitions with well-documented attention-level logic |
| `src/lib/validation.ts` | 90 | Tight, focused input validation — no waste |
| `src/lib/cache.ts` | 88 | Correct TTL cache with cleanup; minor: comment says 60s, default is 5min |
| `src/lib/cn.ts` | 95 | Trivial utility, does its job |
| `src/hooks/useMediaQuery.ts` | 88 | Clean hook with SSR safety |
| `src/hooks/useSessionEvents.ts` | 82 | Solid SSE reducer with membership diffing; complex but justified |
| `src/components/Toast.tsx` | 87 | Clean reducer-based toast with auto-dismiss |
| `src/components/ConnectionBar.tsx` | 90 | Minimal, correct, accessible |
| `src/components/MobileBottomNav.tsx` | 88 | Clean nav with good a11y attributes |
| `src/components/BottomSheet.tsx` | 85 | Good touch gestures, focus trapping, a11y |
| `src/components/CIBadge.tsx` | 86 | Well-structured status component |
| `src/components/AttentionZone.tsx` | 82 | Good responsive kanban/accordion split |
| `src/components/PullRequestsPage.tsx` | 80 | Functional; responsive table/card split |
| `src/components/ProjectSidebar.tsx` | 80 | Clean sidebar with health indicators |
| `src/components/ThemeToggle.tsx` | 88 | Simple, effective |
| `src/components/Skeleton.tsx` | 85 | Good loading states |
| `src/lib/format.ts` | 85 | Small, focused formatting helpers |
| `src/lib/project-utils.ts` | 84 | Clean filtering utilities |
| `src/lib/global-pause.ts` | 86 | Simple state resolution |
| `src/lib/scm-webhooks.ts` | 82 | Well-organized webhook matching |
| `src/lib/observability.ts` | 72 | Global mutable singleton; silent failure pattern |
| `src/lib/dashboard-page-data.ts` | 68 | Unsafe type casting of cached PR data; nested timeout logic |
| `src/lib/serialize.ts` | 65 | Direct mutation of dashboard objects; duplicated cache-write blocks |
| `src/lib/services.ts` | 70 | Massive 410-line file mixing service init with backlog poller logic |
| `src/components/Dashboard.tsx` | 62 | 1060 lines; 7 sub-components crammed into one file; 15+ useState calls |
| `src/components/SessionDetail.tsx` | 64 | 729 lines; mixes PR card, issues list, orchestrator strip, top strip |
| `src/components/SessionCard.tsx` | 58 | 807 lines; deeply nested conditional rendering; `getAlerts` is 80+ lines |
| `src/components/DirectTerminal.tsx` | 63 | 757 lines; single 300-line useEffect; mixed concerns (theme, WS, resize, XDA) |
| `src/app/api/sessions/route.ts` | 74 | Functional with timeout racing; sequential PR enrichment loop |
| `src/app/api/sessions/[id]/send/route.ts` | 76 | Clean validation → action → response; boilerplate |
| `src/app/api/sessions/[id]/kill/route.ts` | 76 | Same pattern, same boilerplate |
| `src/app/api/sessions/[id]/restore/route.ts` | 74 | Good multi-error mapping; same boilerplate |
| `src/app/api/sessions/[id]/message/route.ts` | 68 | Redundant vs `/send`; nested try-catch |
| `src/app/api/sessions/[id]/remap/route.ts` | 64 | String-based error detection is brittle |
| `src/app/api/prs/[id]/merge/route.ts` | 72 | Multi-step validation; missing projectId in error path |
| `src/app/api/issues/route.ts` | 70 | Silent catch blocks hide tracker failures |
| `src/app/api/spawn/route.ts` | 78 | Clean, concise |
| `src/app/api/events/route.ts` | 66 | 235 lines with duplicated snapshot-building logic; polling-based SSE |
| `src/app/api/webhooks/[...slug]/route.ts` | 70 | Mixed verification + parsing + lifecycle in one handler |
| `server/direct-terminal-ws.ts` | 74 | Good stale-session guards; clean observability |
| `server/terminal-websocket.ts` | 68 | Port pooling works; CORS is overly permissive; 444 lines |
| `server/tmux-utils.ts` | 88 | Clean, testable, well-validated |
| `server/terminal-observability.ts` | 82 | Clean observer context factory |

## Detailed Findings

### Complexity & Duplication

**API Route Handler Boilerplate (Critical)**
Every API route in `src/app/api/sessions/[id]/*/route.ts` repeats the same pattern: extract session ID from params, validate with `validateIdentifier`, call `getServices()`, look up session, perform action, record observation, catch errors with `SessionNotFoundError` check, record failure observation, return JSON. This 30–40 line skeleton is duplicated across `send`, `kill`, `restore`, `message`, and `remap` — 5 files sharing ~80% identical structure.

- `send/route.ts:34-87` and `kill/route.ts:16-61`: Nearly identical error handling blocks
- `message/route.ts` vs `send/route.ts`: Both validate a message string and call session manager — functionally the same endpoint with minor differences

**God Components**
- `Dashboard.tsx` (1060 lines): Contains `DashboardInner`, `OrchestratorControl`, `ProjectOverviewGrid`, `ProjectMetric`, `MobileActionStrip`, `StatusCards`, and `BoardLegendItem` — 7 components in one file. `DashboardInner` alone uses 15+ `useState` hooks and 10+ `useEffect` hooks.
- `SessionCard.tsx` (807 lines): The `getAlerts` function (lines ~470-560) builds an alert list through a long chain of conditionals. The render function mixes two completely different layouts (done card vs active card) with deep conditional nesting.
- `DirectTerminal.tsx` (757 lines): A single `useEffect` spanning lines 221-510 (~290 lines) handles dynamic imports, terminal creation, XDA handler registration, OSC 52 handler, selection buffer, keyboard handlers, WebSocket connection with reconnection, and cleanup. This is at least 5 distinct concerns in one effect.

**Duplicated Snapshot Building in SSE**
`src/app/api/events/route.ts` builds the same snapshot object at lines 84-95 (initial) and lines 158-169 (periodic). The mapping logic `dashboardSessions.map(s => ({ id, status, activity, attentionLevel, lastActivityAt }))` is copy-pasted.

**Duplicated PR Cache Write Blocks**
`src/lib/serialize.ts:241-254` and `257-269` construct identical `PREnrichmentData` objects — the only difference is the TTL passed to `prCache.set()`. The 13-field object literal is duplicated verbatim.

### Style & Convention Adherence

**Consistent Patterns (Good)**
- All API routes use `getCorrelationId` + `jsonWithCorrelation` + `recordApiObservation`
- All components use `cn()` for conditional class names
- Design system tokens are used consistently (e.g., `var(--color-status-*)`)
- TypeScript strict mode is enforced; no `any` types found

**Inconsistencies**
- `message/route.ts` uses nested try-catch while other routes use flat try-catch. The inner catch re-throws, adding complexity without value.
- `remap/route.ts:52-56` detects error type via `msg.includes("not using the opencode agent")` — every other route uses `instanceof` checks against typed error classes.
- Cache comment at `cache.ts:6` says "Default TTL: 60 seconds" but the actual default is `5 * 60_000` (5 minutes) at line 13.
- `prCache` is documented as "60s TTL" at line 108 but uses the default constructor (5 minutes).

**Inline SVG Proliferation**
SVG icons are defined inline throughout: `Dashboard.tsx` has ~12 inline SVGs, `SessionCard.tsx` has ~15, `SessionDetail.tsx` has ~10, `DirectTerminal.tsx` has ~6. The close icon (`<path d="M18 6 6 18M6 6l12 12" />`) appears in at least 3 files. No shared icon component exists.

### Readability & Maintainability

**Well-Structured Code (Strengths)**
- `types.ts`: `getAttentionLevel()` is thoroughly documented with inline comments explaining each zone's priority
- `useSessionEvents.ts`: The reducer pattern with membership diffing is complex but well-commented
- `tmux-utils.ts`: Clean separation of find/resolve/validate with testable interfaces
- `BottomSheet.tsx`: Excellent accessibility implementation (focus trapping, escape handling, aria attributes)

**Readability Issues**
- `DirectTerminal.tsx:221-510`: The 290-line useEffect is impenetrable as a single unit. It's a `Promise.all` chain that defines 6+ closures, manages 4 state refs, and handles lifecycle for terminal + WebSocket + selection buffer + keyboard + resize — all in one cleanup scope.
- `SessionCard.tsx`: The render function branches on `isDone` at line ~330, yielding two completely different JSX trees of 150+ lines each. A reader must mentally track which branch they're in.
- `services.ts:216-347`: `pollBacklog()` is a 130-line function that handles 4 distinct responsibilities: label verification, relabel reopened issues, capacity checking, and decomposition + spawning. It reads like a script, not a composable module.

**Mutation Anti-Pattern**
`serialize.ts:enrichSessionPR()` mutates the `dashboard` parameter directly (lines 136-146, 185-226). This makes data flow hard to trace — callers pass an object and it comes back modified. The function both mutates its input and returns a boolean, which is a confusing API.

### Performance Anti-patterns

**Sequential PR Enrichment Loop**
`src/app/api/sessions/route.ts:98-113`: PR enrichment runs sequentially in a for-loop with individual timeout racing per PR. With 20 sessions, this could take up to 20 × 1.5s = 30s before the deadline kicks in. A `Promise.allSettled` with per-item timeouts would be significantly faster.

**Leaked Promise from Timeout Racing**
`src/app/api/sessions/route.ts:19-32`: `settlesWithin()` races a promise against a timeout. When the timeout wins, the original promise continues running in the background — its result is silently discarded, but the work (SCM API calls) keeps consuming resources. There's no `AbortController` to cancel the losing promise.

**Polling-Based SSE**
`src/app/api/events/route.ts:129-192`: The SSE stream polls `sessionManager.list()` every 5 seconds. Every connected client triggers a full session list + serialization + attention-level computation every 5s. With 10 clients, that's 120 session list calls per minute. A push-based event emitter from the session manager would eliminate this.

**Write Buffer Without Backpressure**
`DirectTerminal.tsx:330-346`: The selection write buffer (`writeBuffer[]`) accumulates incoming terminal data while text is selected. There's a 1MB cap and a 5-second safety timer, but between those limits, the buffer can grow rapidly during high-throughput terminal output.

### Security & Error Handling

**Strong Input Validation (Good)**
- `validation.ts`: All user inputs go through `validateString`, `validateIdentifier`, and `stripControlChars`
- Session IDs are regex-validated in both web routes and terminal server
- `tmux-utils.ts:validateSessionId` prevents path traversal via strict `[a-zA-Z0-9_-]+` pattern
- Control characters are stripped from messages sent to tmux to prevent injection

**CORS Vulnerability**
`server/terminal-websocket.ts`: The CORS handler falls back to `*` when the request has no `Origin` header. While the terminal server is typically internal, this permissive default could allow cross-origin requests from non-browser clients or misconfigured proxies.

**Silent Error Swallowing**
- `src/app/api/issues/route.ts:37-39`: Failed tracker queries are silently skipped — if GitHub is down, the API returns an empty list with 200 OK instead of indicating degraded data.
- `src/lib/observability.ts:17-22`: Observer creation failure is swallowed; all subsequent `recordApiObservation` calls silently no-op.
- `src/app/api/events/route.ts:69-71,108-114`: Multiple `void 0` catch blocks discard errors entirely.

**String-Based Error Detection**
`src/app/api/sessions/[id]/remap/route.ts:52-56`: Error routing depends on `msg.includes("not using the opencode agent")`. If the error message changes upstream, the client will get a 500 instead of a 422, with no compile-time protection.

**Unchecked Array Index Access**
`src/app/api/sessions/route.ts:87-88`: `activeIndices.map(index => workerSessions[index])` and `dashboardSessions[index]` access arrays by index without bounds checking. If the filter produces stale indices, this silently returns `undefined`.

## Final Verdict

`packages/web/` is a **functional and well-typed** Next.js application with strong foundations: consistent observability, good input validation, clean type definitions, and solid mobile responsiveness. The codebase is clearly authored by experienced developers who care about security and accessibility.

However, it has accumulated meaningful technical debt in three areas:

1. **Component sprawl**: The four largest components (Dashboard, SessionCard, SessionDetail, DirectTerminal) account for ~3,350 lines and mix multiple concerns. Extracting sub-components and custom hooks would dramatically improve readability and testability.

2. **API route duplication**: The 6 session action routes share ~80% identical boilerplate. A route handler factory or middleware would eliminate hundreds of lines and ensure consistency.

3. **Mutable serialization layer**: `serialize.ts` mutates objects in-place and duplicates cache-write logic, making data flow hard to reason about.

The code is **not** at risk of becoming unmaintainable — the overall architecture (SSR + SSE + terminal WebSocket) is sound and well-organized. But targeted refactoring of the identified areas would yield high ROI.
