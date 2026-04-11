/**
 * Cross-process session recovery helper.
 *
 * The direct-terminal WebSocket server (`direct-terminal-ws.ts`) runs as a
 * standalone Node process — it does NOT have access to `SessionManager` or
 * the plugin registry, because those live inside the Next.js runtime via
 * `getServices()` (see `packages/web/src/lib/services.ts`).
 *
 * When a user tries to open a terminal whose tmux session has died
 * out-of-band (PC crash, `tmux kill-server`, OOM), the mux server calls
 * this helper, which in turn POSTs to the existing
 * `/api/sessions/:id/restore` route. That route owns the plugin registry
 * and calls `sessionManager.restore(id)`, which:
 *
 *   1. Enriches the session so dead-tmux → status "killed".
 *   2. Destroys any stale runtime handle.
 *   3. Reconstructs the launch command via `agent.getRestoreCommand` (or
 *      falls back to `agent.getLaunchCommand`).
 *   4. Spawns a fresh tmux session pointing at the existing worktree.
 *
 * We deliberately reuse `/restore` rather than invent a parallel route so
 * there is a single code path for "bring a dead session back to life" —
 * keep it boring.
 */
/** Max time we wait for the restore route to finish. Agent resume
 *  (e.g. `claude --resume`) can be slow on a cold workspace, so we give
 *  this a generous budget. */
const RECOVERY_TIMEOUT_MS = 30_000;
/**
 * Create a recovery function bound to a specific Next.js port.
 *
 * The returned function takes a session id and asks the Next.js `/restore`
 * route to respawn the tmux session. It is safe to call concurrently for
 * different session ids; the caller is responsible for deduplicating
 * concurrent calls for the *same* id (see `TerminalManager` in
 * `mux-websocket.ts`).
 */
export function createSessionRecoverer(nextPort) {
    const baseUrl = `http://localhost:${nextPort}`;
    return async (sessionId) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), RECOVERY_TIMEOUT_MS);
        try {
            const res = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/restore`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // Empty body = restore with persisted agent, no overrides.
                body: "{}",
                signal: controller.signal,
            });
            if (res.ok) {
                return { ok: true };
            }
            // Extract a useful reason from the route's JSON error envelope
            // (see e.g. `packages/web/src/app/api/sessions/[id]/restore/route.ts`).
            let reason;
            try {
                const body = (await res.json());
                if (typeof body.error === "string") {
                    reason = body.error;
                }
            }
            catch {
                // Non-JSON body — fall through with just the status.
            }
            return {
                ok: false,
                status: res.status,
                reason: reason ?? `restore failed with status ${res.status}`,
            };
        }
        catch (err) {
            if (controller.signal.aborted) {
                return {
                    ok: false,
                    reason: `restore timed out after ${RECOVERY_TIMEOUT_MS}ms`,
                };
            }
            return {
                ok: false,
                reason: err instanceof Error ? err.message : String(err),
            };
        }
        finally {
            clearTimeout(timeoutId);
        }
    };
}
