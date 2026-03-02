/**
 * Launch the internal HTTP server for inter-process lifecycle signalling.
 *
 * The lifecycle manager does NOT live in the CLI process — the CLI starts
 * the dashboard and orchestrator agent. The internal server here acts as
 * a signal relay: it receives hook push signals and forwards them to the
 * session manager to trigger an immediate metadata refresh.
 */

import http from "node:http";
import { createInternalServer } from "@composio/ao-core";
import type { LifecycleManager, SessionManager } from "@composio/ao-core";

/**
 * Build a minimal LifecycleManager adapter that delegates check() to
 * sessionManager.get(), which forces a metadata refresh. The full
 * lifecycle manager runs inside the orchestrator agent's process, not here.
 */
function buildLifecycleAdapter(sm: SessionManager): LifecycleManager {
  return {
    start: () => {},
    stop: () => {},
    getStates: () => new Map(),
    check: async (sessionId: string) => {
      // sm.get() re-reads metadata from disk and enriches with live state,
      // which is what triggers the next SSE poll cycle to pick up new state.
      await sm.get(sessionId);
    },
  };
}

export async function startInternalServer(
  sm: SessionManager,
  port = 3101,
): Promise<http.Server> {
  const lifecycle = buildLifecycleAdapter(sm);
  const server = createInternalServer(lifecycle, port);

  // Bind to loopback only — never 0.0.0.0
  server.listen(port, "127.0.0.1");

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  // Resolve actual port (for port 0 / OS-assigned)
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;

  // Make port available to child processes (agents)
  process.env["AO_INTERNAL_PORT"] = String(actualPort);

  return server;
}
