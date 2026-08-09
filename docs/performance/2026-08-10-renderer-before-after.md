# Renderer performance: before and after

## Scope

This report compares the renderer baseline in `.gstack/benchmark-reports/2026-08-09-benchmark.md` with the current `perf/react-rendering-scout` branch at `b3b21330b`.

The baseline is the right source of truth for this report: it measured the Vite development renderer at `http://localhost:5173/` with React Scan `0.5.7` enabled. The follow-up uses the same URL, instrumentation, headless Chromium, and a fresh browser session.

The “after” run was one cold local navigation. Transfer and request counts are strong indicators of the module-graph change. Timing needs repeated Electron runs before it becomes a release gate.

## Development renderer benchmark

| Metric | Before | After | Delta |
| --- | ---: | ---: | ---: |
| TTFB | 22.3 ms | 10.2 ms | -12.1 ms (-54%) |
| FCP | 603.7 ms | Not exposed by this headless run | — |
| DOM interactive | 39.3 ms | 17.5 ms | -21.8 ms (-55%) |
| DOM complete / full load | 350.6 ms | 680.2 ms | +329.6 ms (+94%) |
| Requests | 248 | 101 | -147 (-59%) |
| Total transfer | 12.68 MB | 5.73 MB | -6.95 MB (-55%) |
| JavaScript transfer | 12.59 MB | 5.73 MB | -6.86 MB (-54%) |
| React Scan module | 676 KB | 676 KB | Flat |

### Reading the result

- **The major win is startup payload:** locale catalogs now load on demand, taking 147 requests and roughly 6.9 MB of JavaScript out of the default development path.
- **React Scan is unchanged:** it remains development-only and accounts for roughly 676 KB in both measurements.
- **DOM complete is not accepted as a regression yet:** this is a single local run and can include the still-open development requests called out in the original baseline. It must be repeated in the real Electron renderer with the same workspace fixture before changing code on its account.
- **FCP is pending:** the current headless browser did not expose a paint entry, so there is no valid after value. Do not compare the old 603.7 ms number against a substitute metric.

## Production artifact cross-check

The development baseline above is the primary comparison. The production build confirms the payload movement independently:

| Metric | `main` | Performance branch | Delta |
| --- | ---: | ---: | ---: |
| Main entry bundle, minified | 1,438.34 kB | 1,211.87 kB | -226.47 kB (-15.7%) |
| Main entry bundle, gzip | 427.17 kB | 371.88 kB | -55.29 kB (-12.9%) |
| Initial resource requests | 23 | 23 | 0 |
| Initial transfer | 1,001,781 B | 948,227 B | -53,554 B (-5.3%) |
| DOM complete, local preview | 89.2 ms | 66.9 ms | -22.3 ms (-25%) |

The branch emits seven non-English locale chunks on demand, each 50–66 kB minified (roughly 15–16 kB gzip), rather than placing every catalog in the initial entry.

## Rendering interaction checks

| Scenario | Before | After | Evidence |
| --- | ---: | ---: | --- |
| New-task prompt, 38 ordinary characters | At least 38 state-triggered updates | At most 5 commits | React Profiler regression test |
| Chat composer, 57 ordinary characters | At least 57 state-triggered updates | At most 2 commits | React Profiler regression test |
| Report-problem title and details | Full draft formatted on every change | Draft formatted only when submitted | Component implementation and behavior tests |

The “before” interaction figures are code-derived lower bounds, not a historical profiler capture: the old controlled inputs updated React state for every character. The new tests enforce the after caps while leaving slash-command and file-mention completion reactive.

## Verification

- `npm test` in `frontend`: 165 test files passed; 2,116 tests passed; 1 skipped.
- `npm run typecheck` in `frontend`: passed.
- Current development benchmark: fresh headless navigation to `http://localhost:5173/` with React Scan enabled.
- Production cross-check: both `main` and the performance branch built with `VITE_NO_ELECTRON=1 npx vite build --config vite.renderer.config.ts`.

## Next benchmark pass

Run the original Vite + Electron flow at least ten times per revision with a fixed workspace fixture. That should produce comparable FCP, first-usable-shell, command-palette latency, long-task, and FPS values, and confirm or reject the one-run DOM-complete increase.

Related plan: [renderer performance optimization plan](../plans/2026-08-10-renderer-performance-optimization.md).
