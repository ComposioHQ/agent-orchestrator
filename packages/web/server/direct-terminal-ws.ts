/**
 * Direct WebSocket terminal server using node-pty.
 * Connects browser xterm.js directly to tmux sessions via WebSocket.
 *
 * This bypasses ttyd and gives us control over terminal initialization,
 * allowing us to implement the XDA (Extended Device Attributes) handler
 * that tmux requires for clipboard support.
 */

import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { homedir, userInfo } from "node:os";
import { createCorrelationId } from "@composio/ao-core";

// node-pty is an optionalDependency — it requires native compilation and may
// not be available on all platforms. Load it dynamically so the rest of the
// server can still start even if node-pty is missing.
/* eslint-disable @typescript-eslint/consistent-type-imports -- node-pty is optional; static import would crash if missing */
type IPty = import("node-pty").IPty;
let ptySpawn: typeof import("node-pty").spawn | undefined;
/* eslint-enable @typescript-eslint/consistent-type-imports */
try {
  const nodePty = await import("node-pty");
  ptySpawn = nodePty.spawn;
} catch {
  console.warn("[DirectTerminal] node-pty not available — direct terminal will be disabled.");
  console.warn("[DirectTerminal] Install it with: npm install node-pty");
}
import { findTmux, resolveTmuxSession, validateSessionId } from "./tmux-utils.js";
import { createObserverContext, inferProjectId } from "./terminal-observability.js";

interface TerminalSession {
  sessionId: string;
  pty: IPty;
  ws: WebSocket;
}

interface WebsocketHealthMetrics {
  activeConnections: number;
  totalConnections: number;
  totalDisconnects: number;
  totalErrors: number;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastErrorAt: string | null;
  lastDisconnectReason: string | null;
  lastErrorReason: string | null;
}

export interface DirectTerminalServer {
  server: Server;
  wss: WebSocketServer;
  activeSessions: Map<string, TerminalSession>;
  shutdown: () => void;
}

/**
 * Create the direct terminal WebSocket server.
 * Separated from listen() so tests can control lifecycle.
 */
export function createDirectTerminalServer(tmuxPath?: string): DirectTerminalServer {
  const TMUX = tmuxPath ?? findTmux();
  const activeSessions = new Map<string, TerminalSession>();
  const { config, observer } = createObserverContext("terminal-direct-websocket");
  const metrics: WebsocketHealthMetrics = {
    activeConnections: 0,
    totalConnections: 0,
    totalDisconnects: 0,
    totalErrors: 0,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastErrorAt: null,
    lastDisconnectReason: null,
    lastErrorReason: null,
  };

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          active: activeSessions.size,
          sessions: Array.from(activeSessions.keys()),
          metrics,
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  const wss = new WebSocketServer({
    server,
    path: "/ws",
  });

  const recordWebsocketMetric = (input: {
    metric: "websocket_connect" | "websocket_disconnect" | "websocket_error";
    outcome: "success" | "failure";
    sessionId?: string;
    reason?: string;
    data?: Record<string, unknown>;
  }): void => {
    if (!observer) {
      return;
    }
    const correlationId = createCorrelationId("ws");
    observer.recordOperation({
      metric: input.metric,
      operation: `terminal.websocket.${input.metric}`,
      outcome: input.outcome,
      correlationId,
      projectId: input.sessionId ? inferProjectId(config, input.sessionId) : undefined,
      sessionId: input.sessionId,
      reason: input.reason,
      data: input.data,
      level: input.outcome === "failure" ? "error" : "info",
    });
  };

  wss.on("connection", (ws, req) => {
    if (!ptySpawn) {
      ws.close(1011, "Direct terminal unavailable — node-pty not installed");
      return;
    }

    const url = new URL(req.url ?? "/", "ws://localhost");
    const sessionId = url.searchParams.get("session");

    if (!sessionId) {
      console.error("[DirectTerminal] Missing session parameter");
      recordWebsocketMetric({
        metric: "websocket_error",
        outcome: "failure",
        reason: "Missing session parameter",
      });
      ws.close(1008, "Missing session parameter");
      return;
    }

    // Validate session ID format
    if (!validateSessionId(sessionId)) {
      console.error("[DirectTerminal] Invalid session ID:", sessionId);
      recordWebsocketMetric({
        metric: "websocket_error",
        outcome: "failure",
        sessionId,
        reason: "Invalid session ID",
      });
      ws.close(1008, "Invalid session ID");
      return;
    }

    // Resolve tmux session name: try exact match first, then suffix match
    // (hash-prefixed sessions like "8474d6f29887-ao-15" are accessed by user-facing ID "ao-15")
    const tmuxSessionId = resolveTmuxSession(sessionId, TMUX);
    if (!tmuxSessionId) {
      console.error("[DirectTerminal] tmux session not found:", sessionId);
      recordWebsocketMetric({
        metric: "websocket_error",
        outcome: "failure",
        sessionId,
        reason: "Session not found",
      });
      ws.close(4004, "Session not found");
      return;
    }

    console.log(`[DirectTerminal] New connection for session: ${tmuxSessionId}`);

    // Enable mouse mode for scrollback support
    const mouseProc = spawn(TMUX, ["set-option", "-t", tmuxSessionId, "mouse", "on"]);
    mouseProc.on("error", (err) => {
      console.error(`[DirectTerminal] Failed to set mouse mode for ${tmuxSessionId}:`, err.message);
    });

    // Hide the green status bar for cleaner appearance
    const statusProc = spawn(TMUX, ["set-option", "-t", tmuxSessionId, "status", "off"]);
    statusProc.on("error", (err) => {
      console.error(
        `[DirectTerminal] Failed to hide status bar for ${tmuxSessionId}:`,
        err.message,
      );
    });

    // Build complete environment - node-pty requires proper env setup
    const homeDir = process.env.HOME || homedir();
    const currentUser = process.env.USER || userInfo().username;
    const env = {
      HOME: homeDir,
      SHELL: process.env.SHELL || "/bin/bash",
      USER: currentUser,
      PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      TERM: "xterm-256color",
      LANG: process.env.LANG || "en_US.UTF-8",
      TMPDIR: process.env.TMPDIR || "/tmp",
    };

    let pty: IPty;
    try {
      console.log(`[DirectTerminal] Spawning PTY: tmux attach-session -t ${tmuxSessionId}`);

      pty = ptySpawn(TMUX, ["attach-session", "-t", tmuxSessionId], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: homeDir,
        env,
      });

      console.log(`[DirectTerminal] PTY spawned successfully`);
    } catch (err) {
      console.error(`[DirectTerminal] Failed to spawn PTY:`, err);
      recordWebsocketMetric({
        metric: "websocket_error",
        outcome: "failure",
        sessionId,
        reason: err instanceof Error ? err.message : String(err),
      });
      ws.close(
        1011,
        `Failed to spawn terminal: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const session: TerminalSession = { sessionId, pty, ws };
    activeSessions.set(sessionId, session);

    metrics.totalConnections += 1;
    metrics.activeConnections = activeSessions.size;
    metrics.lastConnectedAt = new Date().toISOString();
    recordWebsocketMetric({
      metric: "websocket_connect",
      outcome: "success",
      sessionId,
      data: { activeConnections: metrics.activeConnections },
    });

    let disconnectRecorded = false;
    const recordDisconnect = (outcome: "success" | "failure", reason: string) => {
      if (disconnectRecorded) return;
      disconnectRecorded = true;
      const activeConnections = activeSessions.size;
      metrics.activeConnections = activeConnections;
      metrics.totalDisconnects += 1;
      metrics.lastDisconnectedAt = new Date().toISOString();
      metrics.lastDisconnectReason = reason;
      recordWebsocketMetric({
        metric: "websocket_disconnect",
        outcome,
        sessionId,
        reason,
        data: { activeConnections },
      });
    };

    // PTY -> WebSocket
    pty.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // PTY exit
    pty.onExit(({ exitCode }) => {
      console.log(`[DirectTerminal] PTY exited for ${sessionId} with code ${exitCode}`);
      // Guard against stale exits: only delete if this pty is still the active one.
      // A new connection may have already replaced this session entry.
      if (activeSessions.get(sessionId)?.pty === pty) {
        activeSessions.delete(sessionId);
      }
      recordDisconnect(exitCode === 0 ? "success" : "failure", `pty_exit:${exitCode}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "Terminal session ended");
      }
    });

    // WebSocket -> PTY
    ws.on("message", (data) => {
      const message = data.toString("utf8");

      // Handle resize messages (sent by xterm.js FitAddon)
      if (message.startsWith("{")) {
        try {
          const parsed = JSON.parse(message) as { type?: string; cols?: number; rows?: number };
          if (parsed.type === "resize" && parsed.cols && parsed.rows) {
            pty.resize(parsed.cols, parsed.rows);
            return;
          }
        } catch {
          // Not JSON, treat as terminal input
        }
      }

      // Normal terminal input
      pty.write(message);
    });

    // WebSocket close
    ws.on("close", () => {
      console.log(`[DirectTerminal] WebSocket closed for ${sessionId}`);
      // Guard against stale closes replacing a newer session's entry
      if (activeSessions.get(sessionId)?.pty === pty) {
        activeSessions.delete(sessionId);
      }
      recordDisconnect("success", "ws_close");
      pty.kill();
    });

    // WebSocket error
    ws.on("error", (err) => {
      console.error(`[DirectTerminal] WebSocket error for ${sessionId}:`, err.message);
      // Guard against stale error handlers replacing a newer session's entry
      if (activeSessions.get(sessionId)?.pty === pty) {
        activeSessions.delete(sessionId);
      }
      recordDisconnect("failure", `ws_error:${err.message}`);
      metrics.totalErrors += 1;
      metrics.lastErrorAt = new Date().toISOString();
      metrics.lastErrorReason = err.message;
      recordWebsocketMetric({
        metric: "websocket_error",
        outcome: "failure",
        sessionId,
        reason: err.message,
      });
      pty.kill();
    });
  });

  function shutdown() {
    for (const [, session] of activeSessions) {
      session.pty.kill();
      session.ws.close(1001, "Server shutting down");
    }
    server.close();
  }

  return { server, wss, activeSessions, shutdown };
}

// --- Run as standalone script ---
// Only start the server when executed directly (not imported by tests)
const isMainModule =
  process.argv[1]?.endsWith("direct-terminal-ws.ts") ||
  process.argv[1]?.endsWith("direct-terminal-ws.js");

if (isMainModule) {
  const TMUX = findTmux();
  console.log(`[DirectTerminal] Using tmux: ${TMUX}`);

  const { server, shutdown } = createDirectTerminalServer(TMUX);
  const PORT = parseInt(process.env.DIRECT_TERMINAL_PORT ?? "14801", 10);

  server.listen(PORT, () => {
    console.log(`[DirectTerminal] WebSocket server listening on port ${PORT}`);
  });

  function handleShutdown(signal: string) {
    console.log(`[DirectTerminal] Received ${signal}, shutting down...`);
    shutdown();
    const forceExitTimer = setTimeout(() => {
      console.error("[DirectTerminal] Forced shutdown after timeout");
      process.exit(1);
    }, 5000);
    forceExitTimer.unref();
  }

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
}
