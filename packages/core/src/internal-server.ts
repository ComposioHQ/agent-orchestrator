/**
 * Internal HTTP server for inter-process lifecycle signalling.
 * Binds to 127.0.0.1 only — never externally reachable.
 *
 * Endpoints:
 *   POST /internal/check/:sessionId  — trigger lifecycleManager.check() immediately
 *   GET  /internal/health            — liveness check
 */

import http from "node:http";
import type { LifecycleManager } from "./types.js";

export function createInternalServer(
  lifecycle: LifecycleManager,
  port = 3101,
): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    res.setHeader("Content-Type", "application/json");

    // POST /internal/check/:sessionId
    const checkMatch = /^\/internal\/check\/(.+)$/.exec(url);
    if (method === "POST" && checkMatch) {
      const sessionId = decodeURIComponent(checkMatch[1]);
      lifecycle.check(sessionId).then(
        () => {
          res.writeHead(200).end(JSON.stringify({ ok: true }));
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : "unknown error";
          res.writeHead(500).end(JSON.stringify({ error: message }));
        },
      );
      return;
    }

    // GET /internal/health
    if (method === "GET" && url === "/internal/health") {
      const states = Object.fromEntries(lifecycle.getStates());
      res.writeHead(200).end(JSON.stringify({ ok: true, sessions: Object.keys(states).length }));
      return;
    }

    res.writeHead(404).end(JSON.stringify({ error: "not found" }));
  });

  return server;
}
