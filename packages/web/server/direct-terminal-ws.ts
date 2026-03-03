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
import {
  findTmux,
  resolveTerminalAttachTarget,
  tryLoadConfig,
  validateSessionId,
  type TerminalAttachTarget,
} from "./tmux-utils.js";

interface TerminalSession {
  sessionId: string;
  pty: IPty;
  ws: WebSocket;
}

export interface DirectTerminalServer {
  server: Server;
  wss: WebSocketServer;
  activeSessions: Map<string, TerminalSession>;
  shutdown: () => void;
}

function killPty(pty: IPty): void {
  try {
    pty.kill();
  } catch {
    // PTY may have already exited — ignore
  }
}

/**
 * Create the direct terminal WebSocket server.
 * Separated from listen() so tests can control lifecycle.
 */
export function createDirectTerminalServer(tmuxPath?: string): DirectTerminalServer {
  const TMUX = tmuxPath ?? findTmux();
  const config = tryLoadConfig();
  const activeSessions = new Map<string, TerminalSession>();

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

    if (!validateSessionId(sessionId)) {
      console.error("[DirectTerminal] Invalid session ID:", sessionId);
      ws.close(1008, "Invalid session ID");
      return;
    }

    const target = resolveTerminalAttachTarget(config, sessionId, TMUX);
    if (!target) {
      console.error("[DirectTerminal] terminal session not found:", sessionId);
      ws.close(1008, "Session not found");
      return;
    }

    console.log(`[DirectTerminal] New connection for session: ${sessionId} (${target.mode})`);

    if (target.mode === "tmux") {
      applyTmuxOptions(TMUX, target.tmuxSessionId);
    }

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
      const [cmd, args, cwd] = buildPtyCommand(target, TMUX, homeDir);
      console.log(`[DirectTerminal] Spawning PTY: ${cmd} ${args.join(" ")}`);

      pty = ptySpawn(cmd, args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
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

    pty.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    pty.onExit(({ exitCode }) => {
      console.log(`[DirectTerminal] PTY exited for ${sessionId} with code ${exitCode}`);
      if (activeSessions.get(sessionId)?.pty === pty) {
        activeSessions.delete(sessionId);
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "Terminal session ended");
      }
    });

    ws.on("message", (data) => {
      const message = data.toString("utf8");

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

      pty.write(message);
    });

    ws.on("close", () => {
      console.log(`[DirectTerminal] WebSocket closed for ${sessionId}`);
      if (activeSessions.get(sessionId)?.pty === pty) {
        activeSessions.delete(sessionId);
      }
      killPty(pty);
    });

    ws.on("error", (err) => {
      console.error(`[DirectTerminal] WebSocket error for ${sessionId}:`, err.message);
      if (activeSessions.get(sessionId)?.pty === pty) {
        activeSessions.delete(sessionId);
      }
      killPty(pty);
    });
  });

  function shutdown() {
    for (const [, session] of activeSessions) {
      killPty(session.pty);
      session.ws.close(1001, "Server shutting down");
    }
    server.close();
  }

  return { server, wss, activeSessions, shutdown };
}

function applyTmuxOptions(tmuxBinary: string, tmuxSessionId: string): void {
  const mouseProc = spawn(tmuxBinary, ["set-option", "-t", tmuxSessionId, "mouse", "on"]);
  mouseProc.on("error", (err) => {
    console.error(`[DirectTerminal] Failed to set mouse mode for ${tmuxSessionId}:`, err.message);
  });

  const statusProc = spawn(tmuxBinary, ["set-option", "-t", tmuxSessionId, "status", "off"]);
  statusProc.on("error", (err) => {
    console.error(`[DirectTerminal] Failed to hide status bar for ${tmuxSessionId}:`, err.message);
  });
}

function buildPtyCommand(
  target: TerminalAttachTarget,
  tmuxBinary: string,
  homeDir: string,
): [cmd: string, args: string[], cwd: string] {
  if (target.mode === "tmux") {
    return [tmuxBinary, ["attach-session", "-t", target.tmuxSessionId], homeDir];
  }
  return [
    "opencode",
    ["-s", target.opencodeSessionId, "--attach", target.opencodeServerUrl],
    target.cwd,
  ];
}

// --- Run as standalone script ---
// Only start the server when executed directly (not imported by tests)
const isMainModule = process.argv[1]?.endsWith("direct-terminal-ws.ts") ||
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
