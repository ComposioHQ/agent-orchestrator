/**
 * Multiplexed WebSocket server for terminal multiplexing.
 * Manages multiple terminal connections over a single persistent WebSocket.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { homedir, userInfo } from "node:os";
import { spawn } from "node:child_process";
import { findTmux, resolveTmuxSession, validateSessionId } from "./tmux-utils.js";

// Types copied from src/lib/mux-protocol.ts to avoid cross-boundary imports
// Client → Server
type ClientMessage =
  | { ch: "terminal"; id: string; type: "data"; data: string }
  | { ch: "terminal"; id: string; type: "resize"; cols: number; rows: number }
  | { ch: "terminal"; id: string; type: "open" }
  | { ch: "terminal"; id: string; type: "close" }
  | { ch: "system"; type: "ping" }
  | { ch: "subscribe"; topics: ("sessions")[] };

// Server → Client
type ServerMessage =
  | { ch: "terminal"; id: string; type: "data"; data: string }
  | { ch: "terminal"; id: string; type: "exited"; code: number }
  | { ch: "terminal"; id: string; type: "opened" }
  | { ch: "terminal"; id: string; type: "error"; message: string }
  | { ch: "sessions"; type: "snapshot"; sessions: SessionPatch[] }
  | { ch: "system"; type: "pong" }
  | { ch: "system"; type: "error"; message: string };

interface SessionPatch {
  id: string;
  status: string;
  activity: string | null;
  attentionLevel: string;
  lastActivityAt: string;
}

// node-pty is an optionalDependency — load dynamically
/* eslint-disable @typescript-eslint/consistent-type-imports -- node-pty is optional; static import would crash if missing */
type IPty = import("node-pty").IPty;
let ptySpawn: typeof import("node-pty").spawn | undefined;
/* eslint-enable @typescript-eslint/consistent-type-imports */
try {
  const nodePty = await import("node-pty");
  ptySpawn = nodePty.spawn;
} catch {
  console.warn("[MuxServer] node-pty not available — mux server will be disabled.");
}

interface ManagedTerminal {
  id: string;
  tmuxSessionId: string;
  pty: IPty | null;
  subscribers: Set<(data: string) => void>;
  buffer: string[];
  bufferBytes: number;
}

const RING_BUFFER_MAX = 50 * 1024; // 50KB max per terminal

/**
 * TerminalManager manages PTY processes independently of WebSocket connections.
 * A single manager instance is shared across all mux connections.
 */
class TerminalManager {
  private terminals = new Map<string, ManagedTerminal>();
  private TMUX: string;

  constructor(tmuxPath?: string) {
    this.TMUX = tmuxPath ?? findTmux();
  }

  /**
   * Open/attach to a terminal. If already open, just return.
   * If has subscribers but PTY crashed, re-attach.
   */
  open(id: string): string {
    // Validate and resolve
    if (!validateSessionId(id)) {
      throw new Error(`Invalid session ID: ${id}`);
    }

    const tmuxSessionId = resolveTmuxSession(id, this.TMUX);
    if (!tmuxSessionId) {
      throw new Error(`Session not found: ${id}`);
    }

    // Get or create terminal entry
    let terminal = this.terminals.get(id);
    if (!terminal) {
      terminal = {
        id,
        tmuxSessionId,
        pty: null,
        subscribers: new Set(),
        buffer: [],
        bufferBytes: 0,
      };
      this.terminals.set(id, terminal);
    }

    // If PTY is already attached, we're done
    if (terminal.pty) {
      return tmuxSessionId;
    }

    // Enable mouse mode
    const mouseProc = spawn(this.TMUX, ["set-option", "-t", tmuxSessionId, "mouse", "on"]);
    mouseProc.on("error", (err) => {
      console.error(`[MuxServer] Failed to set mouse mode for ${tmuxSessionId}:`, err.message);
    });

    // Hide the status bar
    const statusProc = spawn(this.TMUX, ["set-option", "-t", tmuxSessionId, "status", "off"]);
    statusProc.on("error", (err) => {
      console.error(`[MuxServer] Failed to hide status bar for ${tmuxSessionId}:`, err.message);
    });

    // Build environment
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

    if (!ptySpawn) {
      throw new Error("node-pty not available");
    }

    // Spawn PTY
    const pty = ptySpawn(this.TMUX, ["attach-session", "-t", tmuxSessionId], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: homeDir,
      env,
    });

    terminal.pty = pty;

    // Wire up data events
    pty.onData((data: string) => {
      // Push to all subscribers
      for (const callback of terminal.subscribers) {
        callback(data);
      }

      // Append to ring buffer
      terminal.buffer.push(data);
      terminal.bufferBytes += Buffer.byteLength(data, "utf8");

      // Trim buffer if over limit
      while (terminal.bufferBytes > RING_BUFFER_MAX && terminal.buffer.length > 0) {
        const removed = terminal.buffer.shift() ?? "";
        terminal.bufferBytes -= Buffer.byteLength(removed, "utf8");
      }
    });

    // Handle PTY exit
    pty.onExit(({ exitCode }) => {
      console.log(`[MuxServer] PTY exited for ${id} with code ${exitCode}`);
      terminal.pty = null;

      // If there are still subscribers, re-attach immediately
      if (terminal.subscribers.size > 0) {
        console.log(`[MuxServer] Re-attaching to ${id} (has ${terminal.subscribers.size} subscribers)`);
        try {
          this.open(id);
        } catch (err) {
          console.error(`[MuxServer] Failed to re-attach ${id}:`, err);
        }
      }
    });

    console.log(`[MuxServer] Opened terminal ${id} (tmux: ${tmuxSessionId})`);
    return tmuxSessionId;
  }

  /**
   * Write data to the PTY if attached
   */
  write(id: string, data: string): void {
    const terminal = this.terminals.get(id);
    if (terminal?.pty) {
      terminal.pty.write(data);
    }
  }

  /**
   * Resize the PTY if attached
   */
  resize(id: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(id);
    if (terminal?.pty) {
      terminal.pty.resize(cols, rows);
    }
  }

  /**
   * Subscribe to terminal data. Returns unsubscribe function.
   * Automatically opens the terminal if needed.
   */
  subscribe(id: string, callback: (data: string) => void): () => void {
    // Ensure terminal is open
    this.open(id);
    const terminal = this.terminals.get(id);
    if (!terminal) {
      throw new Error(`Failed to open terminal: ${id}`);
    }

    // Add subscriber
    terminal.subscribers.add(callback);

    // Return unsubscribe function
    return () => {
      terminal.subscribers.delete(callback);
      // If no subscribers left and PTY is not attached, remove terminal from map
      if (terminal.subscribers.size === 0 && !terminal.pty) {
        this.terminals.delete(id);
      }
    };
  }

  /**
   * Get buffered data for a terminal
   */
  getBuffer(id: string): string {
    const terminal = this.terminals.get(id);
    if (!terminal) return "";
    return terminal.buffer.join("");
  }

  /**
   * Close a terminal (kill PTY and remove from subscribers)
   */
  close(id: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;

    if (terminal.pty) {
      terminal.pty.kill();
      terminal.pty = null;
    }

    // Don't remove from map immediately — let it stay until all subscribers unsubscribe
    // This allows for graceful cleanup if subscribers are still holding references
  }
}

/**
 * Attach mux WebSocket server to an existing HTTP server.
 * Creates a /mux endpoint for multiplexed terminal connections.
 */
export function attachMuxWebSocket(server: Server, tmuxPath?: string): void {
  if (!ptySpawn) {
    console.warn("[MuxServer] node-pty not available — mux WebSocket will be disabled");
    return;
  }

  const terminalManager = new TerminalManager(tmuxPath);

  const wss = new WebSocketServer({
    server,
    path: "/mux",
  });

  wss.on("connection", (ws) => {
    console.log("[MuxServer] New mux connection");

    const subscriptions = new Map<string, () => void>();
    let sessionsPollerInterval: ReturnType<typeof setInterval> | null = null;
    let missedPongs = 0;
    const MAX_MISSED_PONGS = 3;

    // Heartbeat: send pong every 15s
    const heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        const msg: ServerMessage = { ch: "system", type: "pong" };
        ws.send(JSON.stringify(msg));
        missedPongs += 1;

        if (missedPongs >= MAX_MISSED_PONGS) {
          console.log("[MuxServer] Too many missed pongs, closing connection");
          ws.close(1000, "Heartbeat timeout");
        }
      }
    }, 15_000);

    /**
     * Start session polling
     * TODO: Implement in Phase 2 - for now, stub it out to avoid circular import issues
     */
    const startSessionPolling = async (): Promise<void> => {
      if (sessionsPollerInterval) return;

      console.log("[MuxServer] Session polling requested but not yet implemented");
      // Session polling will be implemented in a follow-up phase
      // to avoid importing src/ modules from the server-side TypeScript config
    };

    /**
     * Stop session polling
     */
    const stopSessionPolling = (): void => {
      if (sessionsPollerInterval) {
        clearInterval(sessionsPollerInterval);
        sessionsPollerInterval = null;
      }
    };

    /**
     * Handle incoming messages
     */
    ws.on("message", (data) => {
      // Reset missed pongs on any incoming message
      missedPongs = 0;

      try {
        const msg = JSON.parse(data.toString("utf8")) as ClientMessage;

        if (msg.ch === "system") {
          if (msg.type === "ping") {
            const pong: ServerMessage = { ch: "system", type: "pong" };
            ws.send(JSON.stringify(pong));
          }
        } else if (msg.ch === "terminal") {
          const { id, type } = msg;

          try {
            if (type === "open") {
              // Validate session exists
              terminalManager.open(id);

              // Send buffered data
              const buffer = terminalManager.getBuffer(id);
              if (buffer) {
                const bufferMsg: ServerMessage = {
                  ch: "terminal",
                  id,
                  type: "data",
                  data: buffer,
                };
                ws.send(JSON.stringify(bufferMsg));
              }

              // Send opened confirmation
              const openedMsg: ServerMessage = { ch: "terminal", id, type: "opened" };
              ws.send(JSON.stringify(openedMsg));

              // Subscribe to data if not already subscribed
              if (!subscriptions.has(id)) {
                const unsub = terminalManager.subscribe(id, (data) => {
                  const dataMsg: ServerMessage = {
                    ch: "terminal",
                    id,
                    type: "data",
                    data,
                  };
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(dataMsg));
                  }
                });
                subscriptions.set(id, unsub);
              }
            } else if (type === "data" && "data" in msg) {
              terminalManager.write(id, msg.data);
            } else if (type === "resize" && "cols" in msg && "rows" in msg) {
              terminalManager.resize(id, msg.cols, msg.rows);
            } else if (type === "close") {
              terminalManager.close(id);
              const unsub = subscriptions.get(id);
              if (unsub) {
                unsub();
                subscriptions.delete(id);
              }
            }
          } catch (err) {
            const errorMsg: ServerMessage = {
              ch: "terminal",
              id,
              type: "error",
              message: err instanceof Error ? err.message : String(err),
            };
            ws.send(JSON.stringify(errorMsg));
          }
        } else if (msg.ch === "subscribe") {
          if (msg.topics.includes("sessions")) {
            void startSessionPolling();
          }
        }
      } catch (err) {
        console.error("[MuxServer] Failed to parse message:", err);
        const errorMsg: ServerMessage = {
          ch: "system",
          type: "error",
          message: "Invalid message format",
        };
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(errorMsg));
        }
      }
    });

    /**
     * Handle connection close
     */
    ws.on("close", () => {
      console.log("[MuxServer] Mux connection closed");
      clearInterval(heartbeatInterval);
      stopSessionPolling();

      // Unsubscribe from all terminals
      for (const unsub of subscriptions.values()) {
        unsub();
      }
      subscriptions.clear();
    });

    /**
     * Handle connection error
     */
    ws.on("error", (err) => {
      console.error("[MuxServer] WebSocket error:", err.message);
      clearInterval(heartbeatInterval);
      stopSessionPolling();
    });
  });

  console.log("[MuxServer] Mux WebSocket server attached to /mux");
}
