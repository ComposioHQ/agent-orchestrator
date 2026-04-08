# UI: Instant dashboard loader + correct Portfolio "active" count

## Problem
- Tapping **All Projects** in the sidebar navigates to the dashboard SSR page, which awaits up to ~2.5s of enrichment (metadata 1s + PR 1.5s) before rendering. Next.js App Router blocks navigation on the server component, so the user sees nothing for many seconds (sometimes longer under slow network / GitHub API).
- Portfolio summary in `ProjectSidebar` shows an "active" metric that is actually the total worker-session count (includes `done`, `killed`, `merged`, `cleanup`, `terminated`). Label is misleading.

## Research
- `packages/web/src/app/(with-sidebar)/page.tsx:38` — server component, awaits `enrichSessionsMetadata` (1s race) + PR enrichment (1.5s race) before returning `<Dashboard/>`. No `loading.tsx` sibling exists (`packages/web/src/app/**/loading.tsx` → none).
- `packages/web/src/components/ProjectSidebar.tsx:316-339` — `sessionsByProject` computes `totalWorkers` by counting every non-orchestrator session with no status filter.
- `ProjectSidebar.tsx:476-477` — renders `{totalWorkerSessions}` under label "active".
- Terminal status set already used at `page.tsx:79`: `["merged","killed","cleanup","done","terminated"]`.

## Approach

### 1. Instant loader for dashboard navigation
- Add `packages/web/src/app/(with-sidebar)/loading.tsx` — small client/server component rendering a skeleton/spinner for the dashboard area (sidebar stays, since it's in the layout).
- Skeleton: reuse dark-theme tokens; show a few placeholder Kanban columns/cards. Keep minimal — no new libs.
- Result: Next.js shows this immediately on navigation while the server component resolves.
- Optional nice-to-have: lower the enrichment timeouts or make PR enrichment fully non-blocking via SSE only. Out of scope for this PR unless loader alone is insufficient.

### 2. Fix Portfolio "active" count
- In `ProjectSidebar.tsx` `sessionsByProject` memo, count `totalWorkers` only when `!isOrchestratorSession(s)` AND `s.status` is not in terminal set `{merged, killed, cleanup, done, terminated}`.
- Define the terminal set once at module scope (or import if already exported from `@/lib/project-utils`).
- Label stays "active"; number now matches meaning.

## Files to modify
- `packages/web/src/app/(with-sidebar)/loading.tsx` *(new)*
- `packages/web/src/components/ProjectSidebar.tsx` — active count filter
- `packages/web/src/components/__tests__/ProjectSidebar.test.tsx` — add test for active count excluding terminal statuses

## Risks / open questions
- Loader must not flash on fast navigations — Next.js handles this automatically, but verify.
- Confirm whether `status` values on `DashboardSession` are stringly-typed and match core's terminal set.
- Should "active" also exclude `spawning`? Proposal: no — spawning is "in flight" = active.

## Validation
- `pnpm --filter @composio/ao-web test` — new sidebar test.
- Manual: cold nav from a session page to `?project=all`, confirm skeleton appears within <100ms.
- Manual: create sessions in multiple states (done, killed, working), confirm count matches only non-terminal workers.
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` before push.

## Implementation checklist
- [x] Add `loading.tsx` skeleton under `(with-sidebar)`
- [x] Filter `totalWorkers` by non-terminal status in `ProjectSidebar.tsx`
- [x] Extend `ProjectSidebar.test.tsx` with active-count test
- [x] Run build/typecheck/lint/test
- [x] Commit `feat(web): instant dashboard loader + fix portfolio active count (#ui-improvements)`
- [x] Push branch `feat/ui-improvements`, open PR against `gb-personal`
