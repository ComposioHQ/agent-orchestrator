/**
 * Terminal server that manages ttyd instances for tmux sessions.
 *
 * Runs alongside Next.js. Spawns a ttyd process per session on demand,
 * each on a unique port. The dashboard embeds ttyd via iframe.
 *
 * ttyd handles all the hard parts: xterm.js, WebSocket, ANSI rendering,
 * cursor positioning, resize, input — battle-tested and correct.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request } from "node:http";

interface TtydInstance {
  sessionId: string;
  port: number;
  process: ChildProcess;
}

const instances = new Map<string, TtydInstance>();
let nextPort = 7800; // Start ttyd instances from port 7800

/**
 * Check if ttyd is ready to accept connections by making a test request.
 * Returns a promise that resolves when ttyd is ready or rejects after timeout.
 */
function waitForTtyd(port: number, sessionId: string, timeoutMs = 3000): Promise<void> {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const checkReady = () => {
      if (Date.now() - startTime > timeoutMs) {
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
        resolve();
      });

      req.on("timeout", () => {
        // Request timed out - abort and retry
        req.destroy();
        setTimeout(checkReady, 100);
      });

      req.on("error", () => {
        // Connection refused or other error - ttyd not ready yet, retry
        setTimeout(checkReady, 100);
      });

      req.end();
    };

    checkReady();
  });
}

function getOrSpawnTtyd(sessionId: string): TtydInstance {
  const existing = instances.get(sessionId);
  if (existing) return existing;

  const port = nextPort++;
  console.log(`[Terminal] Spawning ttyd for ${sessionId} on port ${port}`);

  // Enable mouse mode so scroll works as scrollback, not input cycling
  spawn("tmux", ["set-option", "-t", sessionId, "mouse", "on"]);

  // Hide the green status bar for cleaner appearance
  spawn("tmux", ["set-option", "-t", sessionId, "status", "off"]);

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

  proc.on("exit", (code) => {
    console.log(`[Terminal] ttyd ${sessionId} exited with code ${code}`);
    instances.delete(sessionId);
  });

  proc.on("error", (err) => {
    console.error(`[Terminal] ttyd ${sessionId} error:`, err.message);
    instances.delete(sessionId);
  });

  const instance: TtydInstance = { sessionId, port, process: proc };
  instances.set(sessionId, instance);
  return instance;
}

// Simple HTTP API for the dashboard to request terminal URLs
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  // CORS for dashboard
  res.setHeader("Access-Control-Allow-Origin", "*");
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

    const instance = getOrSpawnTtyd(sessionId);

    // Wait for ttyd to be ready before returning the URL
    try {
      await waitForTtyd(instance.port, sessionId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        url: `http://localhost:${instance.port}/${sessionId}/`,
        port: instance.port,
        sessionId,
      }));
    } catch (err) {
      console.error(`[Terminal] ttyd ${sessionId} failed to become ready:`, err);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Terminal server not ready" }));
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
process.on("SIGINT", () => {
  console.log("[Terminal] Shutting down...");
  for (const [, instance] of instances) {
    instance.process.kill();
  }
  server.close();
  process.exit(0);
});
