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
import { spawn as ptySpawn, type IPty } from "node-pty";
import { homedir, userInfo } from "node:os";
import { findTmux, resolveTmuxSession, validateSessionId } from "./tmux-utils.js";

export interface TerminalSession {
  sessionId: string;
  pty: IPty;
  ws: WebSocket;
}

/**
 * Replace an existing terminal session for a user-facing session ID.
 * Returns true when an existing session was found and terminated.
 */
export function replaceExistingSession(
  sessions: Map<string, TerminalSession>,
  sessionId: string,
): boolean {
  const previous = sessions.get(sessionId);
  if (!previous) return false;

  try {
    previous.ws.close(4009, "Replaced by newer connection");
  } catch {
    // Ignore close errors if socket is already gone
  }
  try {
    previous.pty.kill();
  } catch {
    // Ignore kill errors if PTY is already dead
  }
  sessions.delete(sessionId);
  return true;
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
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const HEARTBEAT_TIMEOUT_MS = 90_000;

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          active: activeSessions.size,
          sessions: Array.from(activeSessions.keys()),
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

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", "ws://localhost");
    const sessionId = url.searchParams.get("session");

    if (!sessionId) {
      console.error("[DirectTerminal] Missing session parameter");
      ws.close(1008, "Missing session parameter");
      return;
    }

    // Validate session ID format
    if (!validateSessionId(sessionId)) {
      console.error("[DirectTerminal] Invalid session ID:", sessionId);
      ws.close(1008, "Invalid session ID");
      return;
    }

    // Resolve tmux session name: try exact match first, then suffix match
    // (hash-prefixed sessions like "8474d6f29887-ao-15" are accessed by user-facing ID "ao-15")
    const tmuxSessionId = resolveTmuxSession(sessionId, TMUX);
    if (!tmuxSessionId) {
      console.error("[DirectTerminal] tmux session not found:", sessionId);
      ws.close(1008, "Session not found");
      return;
    }

    console.log(`[DirectTerminal] New connection for session: ${tmuxSessionId}`);

    // Enforce one active PTY per user-facing session ID.
    // Reconnecting clients should replace stale sockets instead of accumulating
    // multiple tmux attach processes for the same logical session.
    if (replaceExistingSession(activeSessions, sessionId)) {
      console.log(`[DirectTerminal] Replacing existing connection for ${sessionId}`);
    }

    // Enable mouse mode for scrollback support
    const mouseProc = spawn(TMUX, ["set-option", "-t", tmuxSessionId, "mouse", "on"]);
    mouseProc.on("error", (err) => {
      console.error(
        `[DirectTerminal] Failed to set mouse mode for ${tmuxSessionId}:`,
        err.message,
      );
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
      ws.close(1011, `Failed to spawn terminal: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const session: TerminalSession = { sessionId, pty, ws };
    activeSessions.set(sessionId, session);
    let cleanedUp = false;
    let lastPongAt = Date.now();

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(heartbeatTimer);
      if (activeSessions.get(sessionId)?.pty === pty) {
        activeSessions.delete(sessionId);
      }
      try {
        pty.kill();
      } catch {
        // PTY may already be dead
      }
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
      cleanup();
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
      cleanup();
    });

    // WebSocket error
    ws.on("error", (err) => {
      console.error(`[DirectTerminal] WebSocket error for ${sessionId}:`, err.message);
      cleanup();
    });

    ws.on("pong", () => {
      lastPongAt = Date.now();
    });

    const heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        console.warn(`[DirectTerminal] Heartbeat timeout for ${sessionId}, terminating socket`);
        ws.terminate();
        cleanup();
        return;
      }
      try {
        ws.ping();
      } catch {
        ws.terminate();
        cleanup();
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref();
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
// Only start the server when executed directly (not imported by tests).
// `tsx watch` sets argv[1] to its own CLI, so also check later args.
const isMainModule = process.argv.some(
  (arg) => arg.endsWith("direct-terminal-ws.ts") || arg.endsWith("direct-terminal-ws.js"),
);

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
