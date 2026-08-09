# Renderer performance optimization plan

## Problem frame

The current renderer baseline is promising during steady-state interaction but is not yet a production benchmark:

| Metric | Current observation | Interpretation |
| --- | ---: | --- |
| TTFB | 22 ms | Dev server response is fast |
| First contentful paint | 604 ms | Includes Vite dev graph and React Scan overhead |
| DOM complete | 351 ms | Navigation timing is not equivalent to usable UI readiness |
| Requests | 248 | Dev-module graph, not shipped request count |
| JavaScript transfer | 12.59 MB | Includes unbundled dev modules and instrumentation |
| React Scan module | 676 KB | Measurement overhead; not production cost |
| Settled interaction FPS | 97 FPS | Healthy after startup |
| Transient startup FPS | 14 FPS | Requires profiling; may be initialization or instrumentation |

The goal is to establish trustworthy production-like measurements, then improve startup, interaction latency, and rerender fan-out without changing user-visible behavior.

## Scope

In scope:

- Renderer startup and first usable frame.
- Warm route changes and command-palette open/search/close.
- React rerender fan-out in the shell, sidebar, board, and session views.
- Initial JavaScript/CSS/font/locale loading.
- Large-fixture behavior for projects and sessions.
- Browser/Electron interaction smoothness and long tasks.

Out of scope for the first pass:

- Replacing TanStack Router or React Query.
- Replacing the daemon or changing backend API boundaries.
- Building a Linear-style local-first sync engine.
- Broad visual redesign.
- Optimizing code based only on React Scan highlight counts without a user-flow metric.

## Target outcomes

These are working targets, not claims about what the current architecture can guarantee. The production baseline must be recorded before accepting or revising them.

### Renderer loading

- Cold first contentful paint: p50 at or below 400 ms; p95 at or below 600 ms.
- Warm first contentful paint: p50 at or below 250 ms.
- First usable shell: p95 at or below 800 ms, excluding daemon startup outside the renderer.
- Initial route JavaScript: reduce the measured production baseline by 30% in the first pass; 50% is a stretch target.
- Initial route should load one locale, not every locale.

### Interaction

- Command palette visible and focused within 100 ms at p95.
- Warm route navigation reaches stable content within 150 ms at p95.
- Common sidebar/board interactions sustain at least 55 FPS, with no sustained frame rate below 50 FPS.
- No interaction flow produces a main-thread task longer than 100 ms; reduce avoidable tasks over 50 ms.
- A single-session update should not rerender the entire shell or board. The exact component-count threshold will be set after profiling rather than guessed in advance.

### Correctness guardrails

- Renderer tests, typecheck, build, and existing browser smoke flows remain green.
- No behavior changes to session lifecycle, daemon communication, routing, or persistence.
- React Scan remains development-only and is excluded from production artifacts.

## Measurement contract

All comparisons use the same fixture, viewport, Electron/Chromium version, OS, and flow. Each scenario runs at least 10 repetitions after one warm-up; report median and p95 rather than a single best run.

### Required scenarios

1. Cold renderer launch with the daemon already available.
2. Warm renderer launch with cached code and data.
3. Open the command palette using the keyboard, type a query, select a result, and close it.
4. Toggle sidebar state and move between the board and a session.
5. Apply a session/status update while a representative board is visible.
6. Repeat scenarios 3–5 with small, medium, and large fixtures.

### Required measurements

- Navigation timing and paint timing.
- First usable UI marker, measured explicitly rather than inferred from DOM complete.
- Long tasks and interaction latency.
- Frame timing during scripted flows.
- Resource count and transfer size in a production build.
- React Scan render history for the same interactions.
- Component render counts for representative updates.

## Implementation units

### 1. Normalize the benchmark

Likely files:

- `frontend/vite.renderer.config.ts`
- `frontend/package.json`
- `frontend/src/renderer/main.tsx`
- `.gstack/benchmark-reports/`

Decisions:

- Keep React Scan enabled only in development.
- Add a packaged/production renderer measurement path before optimizing imports.
- Add explicit performance marks for shell mounted, first route ready, command palette opened, and stable board rendered.
- Record cold and warm runs separately.
- Identify the repeated 404 before using network timing as a success metric.

Proof:

- Production build completes.
- The benchmark can collect all required marks and resource totals.
- React Scan does not appear in the production resource list.

### 2. Build the interaction benchmark harness

Likely files:

- `frontend/e2e/`
- `frontend/playwright.config.*`
- `frontend/src/renderer/lib/dom-selectors.ts`
- `frontend/src/renderer/components/CommandPalette*`

Decisions:

- Use stable semantic selectors and existing test conventions.
- Measure user flows, not arbitrary component renders.
- Keep the first benchmark serial and deterministic; parallel runs can be added after variance is understood.

Proof:

- The same flows run against a fixed fixture.
- Results include median, p95, frame/long-task data, and failure output.

### 3. Profile startup payload and shell readiness

Likely files:

- `frontend/src/renderer/main.tsx`
- `frontend/src/renderer/routes/_shell.tsx`
- `frontend/src/renderer/i18n/instance.ts`
- `frontend/src/renderer/i18n/locales.ts`
- `frontend/vite.renderer.config.ts`

Investigation order:

1. Determine whether all locale modules are included in the initial path.
2. Identify large modules imported by the shell before the first usable frame.
3. Separate renderer paint from daemon status, workspace query, telemetry, and prefetch work.
4. Evaluate lazy loading only for secondary features; preserve the shell’s stable route behavior.

Proof:

- Production resource waterfall and bundle report show what moved out of the critical path.
- Existing locale and shell tests remain green.

### 4. Reduce rerender fan-out

Likely files:

- `frontend/src/renderer/routes/_shell.tsx`
- `frontend/src/renderer/components/Sidebar.tsx`
- `frontend/src/renderer/components/CenterPanelShell.tsx`
- `frontend/src/renderer/hooks/useWorkspaceQuery.ts`
- `frontend/src/renderer/stores/ui-store.ts`
- Board/session components identified by React Scan.

Decisions:

- Optimize only measured broad subscriptions or unstable derived values.
- Prefer narrower store selectors, stable derived data, and component boundaries.
- Do not add memoization without a measured rerender or interaction benefit.
- Preserve React Query cache semantics and route ownership.

Proof:

- A one-session update has localized render history.
- Sidebar-only state changes do not rerender unrelated board/session content.
- Large fixtures do not create a proportional increase in unrelated renders.

### 5. Tune interaction and animation costs

Likely files:

- `frontend/src/renderer/components/CommandPalette*`
- `frontend/src/renderer/components/SettingsDialog*`
- `frontend/src/renderer/styles.css`
- Shared motion/UI primitives identified during profiling.

Decisions:

- Use short, consistent transitions.
- Prefer `transform` and `opacity`; use color transitions only when paint cost is acceptable.
- Avoid `transition: all` and layout-property animations in frequently rendered lists.
- Match command-palette motion to the settings modal as already requested.

Proof:

- Command-K open/close remains visually correct and meets the 100 ms interaction target.
- No new long tasks or frame drops appear in the scripted flow.

## Sequencing

1. Preserve the current React Scan baseline and cleanly separate local benchmark artifacts from code changes.
2. Add production-like build measurement and explicit readiness marks.
3. Rebaseline and revise targets if the production numbers materially differ from the dev numbers.
4. Add the deterministic interaction harness and large fixtures.
5. Profile before changing architecture.
6. Apply one optimization hypothesis at a time and rerun the full benchmark matrix.
7. Keep only changes with a measurable benefit and no correctness regression.
8. Run `npm run frontend:typecheck`, `cd frontend && npm run test`, `cd frontend && npm run build`, and the relevant browser flows before handoff.

## Expected improvement range

The current numbers support these expectations, subject to production measurement:

- FCP: likely 604 ms dev/instrumented → roughly 350–450 ms production-like after removing dev graph and instrumentation; below 300 ms would require a meaningful shell/critical-path improvement.
- Startup jank: transient 14 FPS → should be eliminated or reduced to a short, non-visible initialization spike; steady-state 97 FPS is already good.
- Initial transfer: the 12.59 MB dev graph is not a useful production target. A credible first objective is a 30–50% reduction from the measured production initial route payload, not a comparison against the dev number.
- Interaction responsiveness: preserve the current ~97 FPS steady state while bringing command-palette and route latency under 100–150 ms.
- Rerenders: the goal is not zero renders; it is proportional work—one changed session should update only the components that depend on it.

## Risks

- React Scan can perturb startup and render behavior; every conclusion needs an instrumented and uninstrumented run.
- Dev-server request counts and transfer sizes can lead to false conclusions about shipped performance.
- Lazy loading can trade startup gains for first-use latency; measure warm navigation and first-open flows together.
- More memoization can increase complexity or create stale data if applied without clear ownership.
- Large synthetic fixtures may not represent real daemon event patterns; include event-driven updates in the benchmark.

## Definition of done

- Production-like baseline and interaction benchmark are repeatable locally.
- Targets are measured with median/p95 values and documented fixture conditions.
- At least one startup or critical-path improvement and one rerender/interaction improvement are demonstrated, or the data shows that the current implementation is already within target.
- No unmeasured performance abstractions are introduced.
- Benchmark report records before/after values, rejected hypotheses, and remaining bottlenecks.
