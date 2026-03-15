# Concerns Map

## Purpose
This document highlights technical debt, fragile boundaries, security and performance concerns, and likely hotspots that future work in `agent-orchestrator` should treat carefully.

## Highest-Risk Areas

### 1. Terminal access is still weakly protected
- `packages/web/server/terminal-websocket.ts` explicitly carries a TODO for authentication and currently relies on permissive origin/CORS checks plus a `session` query parameter.
- `packages/web/server/terminal-websocket.ts` also exposes terminal startup via `GET /terminal`, which means access control is effectively coupled to network placement rather than user identity.
- `packages/web/server/direct-terminal-ws.ts` exposes raw tmux attachment over WebSocket with session-id validation, but no user/session authorization boundary.
- `packages/web/server/direct-terminal-ws.ts` serves `/health` with active session identifiers, which is operationally useful but increases information exposure if the port is reachable.
- Future work touching terminal UX, remote deployment, reverse proxies, or multi-user access should treat both servers as security hotspots.

### 2. Session lifecycle behavior is complex and heavily heuristic-driven
- `packages/core/src/session-manager.ts` is a very large hotspot that owns spawn, restore, send, cleanup, metadata repair, PR claiming, and runtime enrichment.
- `packages/core/src/session-manager.ts` uses many best-effort `catch {}` branches around runtime checks, tracker checks, metadata timestamps, cleanup, and enrichment. This improves resilience but also hides partial failures.
- `packages/core/src/session-manager.ts` treats failed message confirmation as a soft success after `runtimePlugin.sendMessage()`. That avoids duplicate dispatches, but it also weakens delivery guarantees and complicates debugging of “message disappeared” incidents.
- `packages/core/src/session-manager.ts` reserves session ids using local metadata plus remote session scans, then retries up to 10,000 times. This is careful, but it is also a sign that session identity allocation is stateful and vulnerable to edge-case drift.
- `packages/core/src/lifecycle-manager.ts` layers polling, state transitions, reaction retries, and escalation on top of session-manager behavior. Changes in session status semantics can cascade into missed or duplicated reactions.

### 3. Trusted-config execution model expands blast radius
- `packages/plugins/runtime-process/src/index.ts` launches configured commands with `shell: true`.
- `packages/plugins/workspace-worktree/src/index.ts` runs `postCreate` hooks through `sh -c`.
- Those choices are documented as intentional and assume trusted YAML config, but they are still an operational and supply-chain risk if configs are shared, templated, generated, or stored in less-trusted repos.
- Any future “config from UI”, “remote config”, or “team-shared config marketplace” work would need a stricter trust model before reusing these execution paths.

## Operational Hotspots

### 4. Workspace cleanup can become destructive when git state is ambiguous
- `packages/plugins/workspace-worktree/src/index.ts` falls back to `rmSync(..., { recursive: true, force: true })` if git-based destroy fails.
- That fallback is guarded by path construction rules, but it still means cleanup correctness depends on earlier path hygiene and metadata fidelity.
- `packages/core/src/session-manager.ts` may trigger workspace destruction during failed spawn, kill, cleanup, and restore paths, so cleanup bugs can fan out across several workflows.

### 5. Plugin loading is intentionally forgiving, which can mask misconfiguration
- `packages/core/src/plugin-registry.ts` swallows builtin plugin load failures and only comments that missing plugins are “fine”.
- `packages/core/src/plugin-registry.ts` does not yet implement loading additional plugins from project config despite the interface suggesting that direction.
- This makes the system flexible for optional dependencies, but also makes broken installs look similar to intentionally absent features.

### 6. Terminal process management has scaling and observability tradeoffs
- `packages/web/server/terminal-websocket.ts` manages a per-session `ttyd` process and a bounded port range from 7800 to 7900.
- `packages/web/server/terminal-websocket.ts` can therefore hit port exhaustion under churn or concurrent use, especially if failed processes leave ports unrecycled.
- `packages/web/server/direct-terminal-ws.ts` spawns a `node-pty` attachment per connection and keeps session state in memory, which is simpler but pushes resource pressure into the web process.
- Both terminal servers expose health/metrics state, but neither appears to enforce backpressure, auth-based rate limiting, or connection quotas.

## Fragile Logic Boundaries

### 7. Status and reaction semantics are spread across multiple layers
- `packages/core/src/lifecycle-manager.ts` infers transitions, dispatches notifications, applies retries, and suppresses duplicate notifications when reactions handle events.
- `packages/core/src/session-manager.ts` separately infers liveness, activity, restoration needs, and delivery readiness from runtime/plugin output.
- Bugs here are likely to show up as “wrong notification”, “session stuck in wrong status”, or “reaction fired twice” rather than simple exceptions.

### 8. Multi-runtime / multi-agent support increases integration surface quickly
- `packages/core/src/plugin-registry.ts`, `packages/core/src/config.ts`, and `packages/core/src/session-manager.ts` form the central extension boundary.
- Adding a new agent/runtime/workspace plugin is low-friction, but compatibility is enforced mostly by convention and runtime behavior rather than by a narrow orchestration core.
- This makes plugin combinations a likely regression hotspot, especially where restore/send/cleanup semantics differ by runtime.

## Performance and Maintenance Debt

### 9. Polling architecture may become expensive as session counts grow
- `packages/core/src/lifecycle-manager.ts` performs periodic polling across all sessions and runs status-specific logic plus reaction dispatch checks.
- `packages/core/src/session-manager.ts` may capture output, check runtime liveness, inspect foreground processes, and query external systems during those flows.
- The design is reasonable for moderate scale, but future work on many-session orchestrators should expect polling cost and external API pressure to become visible.

### 10. The main orchestration files are becoming concentration risks
- `packages/core/src/session-manager.ts` is the clearest maintenance hotspot because it combines persistence, orchestration, runtime control, agent-specific behavior, and cleanup policy.
- `packages/core/src/lifecycle-manager.ts` is the next likely hotspot because business rules, notification policy, and retry/escalation behavior all converge there.
- Refactors in these files should be staged carefully and paired with integration coverage, because small local edits can alter cross-package behavior.

## Areas Worth Extra Verification During Future Changes
- Terminal auth, access scope, and exposure of health/session metadata in `packages/web/server/terminal-websocket.ts` and `packages/web/server/direct-terminal-ws.ts`.
- Cleanup and workspace-destruction paths in `packages/plugins/workspace-worktree/src/index.ts` and `packages/core/src/session-manager.ts`.
- Delivery confirmation and restore behavior in `packages/core/src/session-manager.ts`.
- Polling/reaction correctness and notification duplication in `packages/core/src/lifecycle-manager.ts`.
- Plugin loading, optional dependency behavior, and misconfiguration detection in `packages/core/src/plugin-registry.ts`.
