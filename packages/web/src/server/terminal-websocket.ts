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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@composio/ao-core";

interface TtydInstance {
  sessionId: string;
  port: number;
  process: ChildProcess;
}

const instances = new Map<string, TtydInstance>();
const availablePorts = new Set<number>(); // Pool of recycled ports
let nextPort = 7800; // Start ttyd instances from port 7800
const MAX_PORT = 7900; // Prevent unbounded port allocation

// Load config once at startup
const config = loadConfig();

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

      const req = request({
        hostname: "localhost",
        port,
        path: `/${sessionId}/`,
        method: "GET",
        timeout: 500,
      }, (_res) => {
        // Any response (even 404) means ttyd is listening
        cleanup();
        resolve();
      });

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

function getOrSpawnTtyd(sessionId: string): TtydInstance {
  const existing = instances.get(sessionId);
  if (existing) return existing;

  // Allocate port: reuse from pool if available, otherwise increment
  let port: number;
  if (availablePorts.size > 0) {
    // Reuse a recycled port
    port = availablePorts.values().next().value as number;
    availablePorts.delete(port);
  } else {
    // Allocate new port
    if (nextPort >= MAX_PORT) {
      throw new Error(`Port exhaustion: reached maximum of ${MAX_PORT - 7800} terminal instances`);
    }
    port = nextPort++;
  }

  console.log(`[Terminal] Spawning ttyd for ${sessionId} on port ${port}`);

  // Enable mouse mode for scrollback support
  const mouseProc = spawn("tmux", ["set-option", "-t", sessionId, "mouse", "on"]);
  mouseProc.on("error", (err) => {
    console.error(`[Terminal] Failed to set mouse mode for ${sessionId}:`, err.message);
  });

  // Hide the green status bar for cleaner appearance
  const statusProc = spawn("tmux", ["set-option", "-t", sessionId, "status", "off"]);
  statusProc.on("error", (err) => {
    console.error(`[Terminal] Failed to hide status bar for ${sessionId}:`, err.message);
  });

  const proc = spawn("ttyd", [
    "--writable",
    "--port", String(port),
    "--base-path", `/${sessionId}`,
    "tmux", "attach-session", "-t", sessionId,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (data: Buffer) => {
    console.log(`[Terminal] ttyd ${sessionId}: ${data.toString().trim()}`);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    console.log(`[Terminal] ttyd ${sessionId}: ${data.toString().trim()}`);
  });

  // Use once() for cleanup handlers to prevent race condition when both exit and error fire
  proc.once("exit", (code) => {
    console.log(`[Terminal] ttyd ${sessionId} exited with code ${code}`);
    // Only delete if this is still the current instance (prevents race with error handler)
    const current = instances.get(sessionId);
    if (current?.process === proc) {
      instances.delete(sessionId);
      // Only recycle port on clean exit (code 0), not on errors
      // Failed ttyd processes may leave ports in TIME_WAIT state
      if (code === 0) {
        availablePorts.add(port);
      }
    }
  });

  proc.once("error", (err) => {
    console.error(`[Terminal] ttyd ${sessionId} error:`, err.message);
    // Only delete if this is still the current instance (prevents race with exit handler)
    const current = instances.get(sessionId);
    if (current?.process === proc) {
      instances.delete(sessionId);
      // Don't recycle port on error - may still be in use or TIME_WAIT
    }
    // Kill any running process
    try {
      proc.kill();
    } catch {
      // Ignore kill errors if process already dead
    }
  });

  const instance: TtydInstance = { sessionId, port, process: proc };
  instances.set(sessionId, instance);
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
      return;
    }

    // Validate session ID to prevent path traversal and injection
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid session ID" }));
      return;
    }

    // Validate session exists before spawning ttyd using configured dataDir
    const sessionPath = join(config.dataDir, sessionId);
    if (!existsSync(sessionPath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    // Spawn ttyd and wait for it to be ready (catch port exhaustion and startup failures)
    try {
      const instance = getOrSpawnTtyd(sessionId);
      await waitForTtyd(instance.port, sessionId);

      // Use the request host to construct the terminal URL (supports remote access)
      const host = req.headers.host ?? "localhost";
      const protocol = req.headers["x-forwarded-proto"] ?? "http";

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        url: `${protocol}://${host.split(":")[0]}:${instance.port}/${sessionId}/`,
        port: instance.port,
        sessionId,
      }));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Terminal] Failed to start terminal for ${sessionId}:`, errorMsg);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to start terminal" }));
    }
    return;
  }

  // GET /health
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      instances: Object.fromEntries(
        [...instances.entries()].map(([id, inst]) => [id, { port: inst.port }])
      ),
    }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const PORT = parseInt(process.env.TERMINAL_PORT ?? "3001", 10);

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
