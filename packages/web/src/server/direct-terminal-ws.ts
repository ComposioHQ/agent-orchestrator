/**
 * Direct WebSocket terminal server using node-pty.
 * Connects browser xterm.js directly to tmux sessions via WebSocket.
 *
 * This bypasses ttyd and gives us control over terminal initialization,
 * allowing us to implement the XDA (Extended Device Attributes) handler
 * that tmux requires for clipboard support.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import { loadConfig } from "@composio/ao-core";

// Load config with fallback
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (err) {
  console.warn("[DirectTerminal] Could not load config, using defaults:", err instanceof Error ? err.message : String(err));
  // Fallback to default config
  config = {
    dataDir: join(homedir(), ".ao/sessions"),
  } as ReturnType<typeof loadConfig>;
}

interface TerminalSession {
  sessionId: string;
  pty: IPty;
  ws: WebSocket;
}

const activeSessions = new Map<string, TerminalSession>();

/**
 * Create HTTP server with WebSocket upgrade handling
 */
const server = createServer((req, res) => {
  // Health check endpoint
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      active: activeSessions.size,
      sessions: Array.from(activeSessions.keys()),
    }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

/**
 * WebSocket server for terminal connections
 */
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

  // Validate session ID
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    console.error("[DirectTerminal] Invalid session ID:", sessionId);
    ws.close(1008, "Invalid session ID");
    return;
  }

  // Validate session exists
  const sessionPath = join(config.dataDir, sessionId);
  if (!existsSync(sessionPath)) {
    console.error("[DirectTerminal] Session not found:", sessionId);
    ws.close(1008, "Session not found");
    return;
  }

  console.log(`[DirectTerminal] New connection for session: ${sessionId}`);

  // Enable mouse mode for scrollback support
  const mouseProc = spawn("tmux", ["set-option", "-t", sessionId, "mouse", "on"]);
  mouseProc.on("error", (err) => {
    console.error(`[DirectTerminal] Failed to set mouse mode for ${sessionId}:`, err.message);
  });

  // Hide the green status bar for cleaner appearance
  const statusProc = spawn("tmux", ["set-option", "-t", sessionId, "status", "off"]);
  statusProc.on("error", (err) => {
    console.error(`[DirectTerminal] Failed to hide status bar for ${sessionId}:`, err.message);
  });

  // Spawn PTY attached to tmux session
  // Use tmux from PATH for cross-platform compatibility
  const tmuxPath = "tmux";

  // Build complete environment - node-pty requires proper env setup
  const homeDir = process.env.HOME || homedir();
  const currentUser = process.env.USER || userInfo().username;
  const env = {
    HOME: homeDir,
    SHELL: process.env.SHELL || "/bin/bash",
    USER: currentUser,
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    TERM: "xterm-256color",
    LANG: process.env.LANG || "en_US.UTF-8",
    TMPDIR: process.env.TMPDIR || "/tmp",
  };

  let pty: IPty;
  try {
    console.log(`[DirectTerminal] Spawning PTY: ${tmuxPath} attach-session -t ${sessionId}`);
    console.log(`[DirectTerminal] CWD: ${homeDir}, ENV keys:`, Object.keys(env).join(", "));

    pty = ptySpawn(tmuxPath, ["attach-session", "-t", sessionId], {
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

  // PTY -> WebSocket
  pty.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  // PTY exit
  pty.onExit(({ exitCode }) => {
    console.log(`[DirectTerminal] PTY exited for ${sessionId} with code ${exitCode}`);
    activeSessions.delete(sessionId);
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
    activeSessions.delete(sessionId);
    pty.kill();
  });

  // WebSocket error
  ws.on("error", (err) => {
    console.error(`[DirectTerminal] WebSocket error for ${sessionId}:`, err.message);
    activeSessions.delete(sessionId);
    pty.kill();
  });
});

const PORT = parseInt(process.env.DIRECT_TERMINAL_PORT ?? "3003", 10);

server.listen(PORT, () => {
  console.log(`[DirectTerminal] WebSocket server listening on port ${PORT}`);
});

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`[DirectTerminal] Received ${signal}, shutting down...`);
  for (const [, session] of activeSessions) {
    session.pty.kill();
    session.ws.close(1001, "Server shutting down");
  }
  server.close(() => {
    console.log("[DirectTerminal] Server closed");
    process.exit(0);
  });
  const forceExitTimer = setTimeout(() => {
    console.error("[DirectTerminal] Forced shutdown after timeout");
    process.exit(1);
  }, 5000);
  forceExitTimer.unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
