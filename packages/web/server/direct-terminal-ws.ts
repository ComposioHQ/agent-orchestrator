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
import { getSessionsDir, loadConfig, readMetadataRaw, type OrchestratorConfig } from "@composio/ao-core";
import { findTmux, resolveTmuxSession, validateSessionId } from "./tmux-utils.js";

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

type TerminalAttachTarget =
  | { mode: "tmux"; tmuxSessionId: string }
  | {
      mode: "opencode-attach";
      opencodeSessionId: string;
      opencodeServerUrl: string;
      cwd: string;
    };

function tryLoadConfig(): OrchestratorConfig | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

function resolveTerminalAttachTarget(
  config: OrchestratorConfig | null,
  sessionId: string,
  tmuxBinary: string,
): TerminalAttachTarget | null {
  if (config) {
    for (const project of Object.values(config.projects)) {
      const sessionsDir = getSessionsDir(config.configPath, project.path);
      const raw = readMetadataRaw(sessionsDir, sessionId);
      if (!raw) continue;

      if (
        raw["terminalMode"] === "opencode-attach" &&
        raw["opencodeSessionId"] &&
        raw["opencodeServerUrl"]
      ) {
        return {
          mode: "opencode-attach",
          opencodeSessionId: raw["opencodeSessionId"],
          opencodeServerUrl: raw["opencodeServerUrl"],
          cwd: raw["worktree"] || project.path,
        };
      }

      break;
    }
  }

  const tmuxSessionId = resolveTmuxSession(sessionId, tmuxBinary);
  if (!tmuxSessionId) return null;
  return { mode: "tmux", tmuxSessionId };
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

    // Validate session ID format
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
      // Enable mouse mode for scrollback support
      const mouseProc = spawn(TMUX, ["set-option", "-t", target.tmuxSessionId, "mouse", "on"]);
      mouseProc.on("error", (err) => {
        console.error(
          `[DirectTerminal] Failed to set mouse mode for ${target.tmuxSessionId}:`,
          err.message,
        );
      });

      // Hide the green status bar for cleaner appearance
      const statusProc = spawn(TMUX, ["set-option", "-t", target.tmuxSessionId, "status", "off"]);
      statusProc.on("error", (err) => {
        console.error(
          `[DirectTerminal] Failed to hide status bar for ${target.tmuxSessionId}:`,
          err.message,
        );
      });
    }

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
      const isTmux = target.mode === "tmux";
      const cmd = isTmux ? TMUX : "opencode";
      const args = isTmux
        ? ["attach-session", "-t", target.tmuxSessionId]
        : ["-s", target.opencodeSessionId, "--attach", target.opencodeServerUrl];

      console.log(`[DirectTerminal] Spawning PTY: ${cmd} ${args.join(" ")}`);

      pty = ptySpawn(cmd, args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: target.mode === "opencode-attach" ? target.cwd : homeDir,
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
      // Guard against stale exits: only delete if this pty is still the active one.
      // A new connection may have already replaced this session entry.
      if (activeSessions.get(sessionId)?.pty === pty) {
        activeSessions.delete(sessionId);
      }
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
      pty.kill();
    });

    // WebSocket error
    ws.on("error", (err) => {
      console.error(`[DirectTerminal] WebSocket error for ${sessionId}:`, err.message);
      // Guard against stale error handlers replacing a newer session's entry
      if (activeSessions.get(sessionId)?.pty === pty) {
        activeSessions.delete(sessionId);
      }
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
