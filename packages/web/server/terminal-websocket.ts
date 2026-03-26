/**
 * Terminal server that manages ttyd instances for tmux sessions.
 *
 * Runs alongside Next.js. Spawns a ttyd process per session on demand,
 * each on a unique port. The dashboard embeds ttyd via iframe.
 *
 * ttyd handles all the hard parts: xterm.js, WebSocket, ANSI rendering,
 * cursor positioning, resize, input — battle-tested and correct.
 *
 * TODO: Add authentication middleware to verify:
 *   - User is authenticated
 *   - User owns the requested session
 *   - Rate limiting for terminal access
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { createCorrelationId } from "@composio/ao-core";
import { findTmux, resolveTmuxSession, validateSessionId } from "./tmux-utils.js";
import { createObserverContext, inferProjectId } from "./terminal-observability.js";

/** Cached full path to tmux binary */
const TMUX = findTmux();
console.log(`[Terminal] Using tmux: ${TMUX}`);

interface TtydInstance {
  sessionId: string;
  port: number;
  process: ChildProcess;
}

interface TerminalHealthMetrics {
  activeInstances: number;
  totalSpawns: number;
  totalErrors: number;
  totalReused: number;
  lastSpawnAt?: string;
  lastErrorAt?: string;
  lastErrorReason?: string;
}

const instances = new Map<string, TtydInstance>();
const metrics: TerminalHealthMetrics = {
  activeInstances: 0,
  totalSpawns: 0,
  totalErrors: 0,
  totalReused: 0,
};
const availablePorts = new Set<number>(); // Pool of recycled ports
let nextPort = 7800; // Start ttyd instances from port 7800
const MAX_PORT = 7900; // Prevent unbounded port allocation

const { config: observabilityConfig, observer } = createObserverContext("terminal-websocket");

/** 
 * Mutex to ensure port allocation and ttyd spawning is atomic.
 * Prevents race conditions where concurrent requests might allocate the same port.
 */
let portAllocationLock: Promise<any> = Promise.resolve();

function recordWebsocketMetric(input: {
  metric: "websocket_connect" | "websocket_disconnect" | "websocket_error";
  outcome: "success" | "failure";
  sessionId?: string;
  reason?: string;
  data?: Record<string, unknown>;
}): void {
  if (!observer) {
    return;
  }

  const correlationId = createCorrelationId("ws");
  observer.recordOperation({
    metric: input.metric,
    operation: `terminal.websocket.${input.metric}`,
    outcome: input.outcome,
    correlationId,
    projectId: input.sessionId ? inferProjectId(observabilityConfig, input.sessionId) : undefined,
    sessionId: input.sessionId,
    reason: input.reason,
    data: input.data,
    level: input.outcome === "failure" ? "error" : "info",
  });
}

/**
 * Check if ttyd is ready to accept connections by making a test request.
 * Returns a promise that resolves when ttyd is ready or rejects after timeout.
 * Properly cancels pending timeouts and requests to prevent memory leaks.
 */
function waitForTtyd(port: number, sessionId: string, timeoutMs = 3000): Promise<void> {
  const startTime = Date.now();
  let timeoutId: NodeJS.Timeout | null = null;
  let pendingReq: ReturnType<typeof request> | null = null;
  let settled = false;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (pendingReq) {
        pendingReq.destroy();
        pendingReq = null;
      }
    };

    const checkReady = () => {
      if (settled) return;

      if (Date.now() - startTime > timeoutMs) {
        cleanup();
        reject(new Error(`ttyd did not become ready within ${timeoutMs}ms`));
        return;
      }

      const req = request(
        {
          hostname: "localhost",
          port,
          path: `/${sessionId}/`,
          method: "GET",
          timeout: 500,
        },
        (_res) => {
          // Any response (even 404) means ttyd is listening
          cleanup();
          resolve();
        },
      );

      pendingReq = req;

      req.on("timeout", () => {
        if (settled) return;
        req.destroy();
        pendingReq = null;
        // Schedule retry but track the timeout ID
        timeoutId = setTimeout(checkReady, 100);
      });

      req.on("error", () => {
        if (settled) return;
        pendingReq = null;
        // Connection refused or other error - ttyd not ready yet, retry
        timeoutId = setTimeout(checkReady, 100);
      });

      req.end();
    };

    checkReady();
  });
}

/**
 * Check if a port is available by attempting to listen on it.
 */
async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createTcpServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port);
  });
}

/**
 * Spawn or reuse a ttyd instance for a tmux session.
 *
 * @param sessionId - User-facing session ID (used for base-path and URL)
 * @param tmuxSessionName - Actual tmux session name (may be hash-prefixed)
 */
async function getOrSpawnTtyd(sessionId: string, tmuxSessionName: string): Promise<TtydInstance> {
  const existing = instances.get(sessionId);
  if (existing) {
    metrics.totalReused += 1;
    recordWebsocketMetric({
      metric: "websocket_connect",
      outcome: "success",
      sessionId,
      data: { reused: true, port: existing.port },
    });
    return existing;
  }

  // Use a promise-based mutex to ensure atomic port allocation and spawn.
  // We await the previous allocation cycle before starting the next one.
  const instance = await (portAllocationLock = portAllocationLock.then(async () => {
    // Re-check existence inside lock to prevent double-spawning on concurrent requests for same session
    const lockedExisting = instances.get(sessionId);
    if (lockedExisting) return lockedExisting;

    // Allocate port: prefer pools, but ALWAYS check availability
    let port: number = -1;
    
    // 1. Try recycled ports first
    while (availablePorts.size > 0) {
      const p = availablePorts.values().next().value as number;
      availablePorts.delete(p);
      if (await isPortFree(p)) {
        port = p;
        break;
      }
    }

    // 2. Scan for new port if no valid recycled ports found
    if (port === -1) {
      for (let p = nextPort; p < MAX_PORT; p++) {
        if (await isPortFree(p)) {
          port = p;
          nextPort = p + 1;
          break;
        }
      }
    }

    if (port === -1) {
      throw new Error(`Port exhaustion: could not find a free port in range ${nextPort}-${MAX_PORT}`);
    }

    console.log(`[Terminal] Spawning ttyd for ${tmuxSessionName} on port ${port}`);
    metrics.totalSpawns += 1;
    metrics.lastSpawnAt = new Date().toISOString();

    // Enable mouse mode for scrollback support
    const mouseProc = spawn(TMUX, ["set-option", "-t", tmuxSessionName, "mouse", "on"]);
    mouseProc.on("error", (err) => {
      console.error(`[Terminal] Failed to set mouse mode for ${tmuxSessionName}:`, err.message);
    });

    // Hide the green status bar for cleaner appearance
    const statusProc = spawn(TMUX, ["set-option", "-t", tmuxSessionName, "status", "off"]);
    statusProc.on("error", (err) => {
      console.error(`[Terminal] Failed to hide status bar for ${tmuxSessionName}:`, err.message);
    });

    // Use user-facing sessionId for base-path (matches URL the dashboard uses)
    // Use tmuxSessionName for tmux attach (may be hash-prefixed)
    const proc = spawn(
      "ttyd",
      [
        "--writable",
        "--port",
        String(port),
        "--base-path",
        `/${sessionId}`,
        TMUX,
        "attach-session",
        "-t",
        tmuxSessionName,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const newInstance: TtydInstance = { sessionId, port, process: proc };
    
    // Set up listeners BEFORE returning, while still inside the lock
    proc.stdout?.on("data", (data: Buffer) => {
      console.log(`[Terminal] ttyd ${sessionId}: ${data.toString().trim()}`);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      console.log(`[Terminal] ttyd ${sessionId}: ${data.toString().trim()}`);
    });

    // Use once() for cleanup handlers to prevent race condition when both exit and error fire
    proc.once("exit", (code) => {
      console.log(`[Terminal] ttyd ${sessionId} exited with code ${code}`);
      const current = instances.get(sessionId);
      if (current?.process === proc) {
        instances.delete(sessionId);
        metrics.activeInstances = instances.size;
        if (code === 0) {
          availablePorts.add(port);
        }
      }
      recordWebsocketMetric({
        metric: "websocket_disconnect",
        outcome: code === 0 ? "success" : "failure",
        sessionId,
        reason: `ttyd_exit:${code}`,
        data: { port },
      });
    });

    proc.once("error", (err) => {
      console.error(`[Terminal] ttyd ${sessionId} error:`, err.message);
      const current = instances.get(sessionId);
      if (current?.process === proc) {
        instances.delete(sessionId);
        metrics.activeInstances = instances.size;
      }
      metrics.totalErrors += 1;
      metrics.lastErrorAt = new Date().toISOString();
      metrics.lastErrorReason = err.message;
      recordWebsocketMetric({
        metric: "websocket_error",
        outcome: "failure",
        sessionId,
        reason: err.message,
        data: { port },
      });
      try {
        proc.kill();
      } catch {
        // Ignore kill errors if process already dead
      }
    });

    instances.set(sessionId, newInstance);
    metrics.activeInstances = instances.size;
    recordWebsocketMetric({
      metric: "websocket_connect",
      outcome: "success",
      sessionId,
      data: { reused: false, port },
    });

    return newInstance;
  }).catch((err) => {
     // Ensure lock is unblocked even if allocation fails
     throw err;
  }));

  return instance;
}

// Simple HTTP API for the dashboard to request terminal URLs
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  // CORS for dashboard - allow requests from the same host as the dashboard
  // TODO: Replace with proper session-based authentication
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    // Extract hostname from origin and compare with request host
    try {
      const originUrl = new URL(origin);
      const requestHost = req.headers.host;
      // Allow if origin hostname matches request host (supports remote deployments)
      if (requestHost && originUrl.hostname === requestHost.split(":")[0]) {
        res.setHeader("Access-Control-Allow-Origin", origin);
      }
    } catch {
      // Invalid origin URL, don't set CORS header
    }
  } else {
    // Allow null origin (file:// or local HTML files)
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /terminal?session=ao-1 → returns { url, port }
  if (url.pathname === "/terminal") {
    const sessionId = url.searchParams.get("session");
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing session parameter" }));
      recordWebsocketMetric({
        metric: "websocket_error",
        outcome: "failure",
        reason: "Missing session parameter",
      });
      return;
    }

    // Validate session ID to prevent path traversal and injection
    if (!validateSessionId(sessionId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid session ID" }));
      recordWebsocketMetric({
        metric: "websocket_error",
        outcome: "failure",
        sessionId,
        reason: "Invalid session ID",
      });
      return;
    }

    // Resolve tmux session name: try exact match first, then suffix match
    // (hash-prefixed sessions like "8474d6f29887-ao-15" are accessed by user-facing ID "ao-15")
    const tmuxSessionId = resolveTmuxSession(sessionId, TMUX);
    if (!tmuxSessionId) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      recordWebsocketMetric({
        metric: "websocket_error",
        outcome: "failure",
        sessionId,
        reason: "Session not found",
      });
      return;
    }

    // Spawn ttyd and wait for it to be ready (catch port exhaustion and startup failures)
    try {
      const instance = await getOrSpawnTtyd(sessionId, tmuxSessionId);
      await waitForTtyd(instance.port, sessionId);

      // Use the request host to construct the terminal URL (supports remote access)
      const host = req.headers.host ?? "localhost";
      const protocol = req.headers["x-forwarded-proto"] ?? "http";

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          url: `${protocol}://${host.split(":")[0]}:${instance.port}/${sessionId}/`,
          port: instance.port,
          sessionId,
        }),
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Terminal] Failed to start terminal for ${sessionId}:`, errorMsg);
      metrics.totalErrors += 1;
      metrics.lastErrorAt = new Date().toISOString();
      metrics.lastErrorReason = errorMsg;
      recordWebsocketMetric({
        metric: "websocket_error",
        outcome: "failure",
        sessionId,
        reason: errorMsg,
      });
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to start terminal" }));
    }
    return;
  }

  // GET /health
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        instances: Object.fromEntries(
          [...instances.entries()].map(([id, inst]) => [id, { port: inst.port }]),
        ),
        metrics,
      }),
    );
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const PORT = parseInt(process.env.TERMINAL_PORT ?? "14800", 10);

server.listen(PORT, () => {
  console.log(`[Terminal] Server listening on port ${PORT}`);
});

// Graceful shutdown — kill all ttyd instances
function shutdown(signal: string) {
  console.log(`[Terminal] Received ${signal}, shutting down...`);
  for (const [, instance] of instances) {
    instance.process.kill();
  }
  server.close(() => {
    console.log("[Terminal] Server closed");
    process.exit(0);
  });
  // Force exit after 5s if graceful shutdown hangs
  // Use unref() so this timer doesn't prevent process exit if server closes quickly
  const forceExitTimer = setTimeout(() => {
    console.error("[Terminal] Forced shutdown after timeout");
    process.exit(1);
  }, 5000);
  forceExitTimer.unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
