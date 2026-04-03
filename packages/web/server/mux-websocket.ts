/**
 * Multiplexed WebSocket server for terminal multiplexing.
 * Manages multiple terminal connections over a single persistent WebSocket.
 *
 * Session updates are delivered via a single shared SSE connection from this
 * process to Next.js /api/events, then broadcast to all subscribed clients.
 * This replaces per-client HTTP polling and makes session updates event-driven.
 */

import { WebSocketServer, WebSocket } from "ws";
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

/**
 * Manages a single shared SSE connection to Next.js /api/events.
 * Broadcasts session patches to all subscribed callbacks.
 * Lazily connects on first subscriber, disconnects when the last one leaves.
 */
class SessionBroadcaster {
  private subscribers = new Set<(sessions: SessionPatch[]) => void>();
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly baseUrl: string;

  constructor(nextPort: string) {
    this.baseUrl = `http://localhost:${nextPort}`;
  }

  /**
   * Subscribe to session patches. Returns an unsubscribe function.
   * Sends an immediate snapshot to the new subscriber, then live SSE pushes.
   */
  subscribe(callback: (sessions: SessionPatch[]) => void): () => void {
    const wasEmpty = this.subscribers.size === 0;
    this.subscribers.add(callback);

    // Immediately send a one-off snapshot to just this new subscriber
    void this.fetchSnapshot().then((sessions) => {
      if (sessions && this.subscribers.has(callback)) {
        callback(sessions);
      }
    });

    // Start the shared SSE connection if this is the first subscriber
    if (wasEmpty) {
      void this.connect();
    }

    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) {
        this.disconnect();
      }
    };
  }

  private broadcast(sessions: SessionPatch[]): void {
    for (const callback of this.subscribers) {
      callback(sessions);
    }
  }

  /** One-shot HTTP fetch of the current session list for immediate delivery. */
  private async fetchSnapshot(): Promise<SessionPatch[] | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      try {
        const res = await fetch(`${this.baseUrl}/api/sessions/patches`, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!res.ok) return null;
        const data = (await res.json()) as { sessions?: SessionPatch[] };
        return data.sessions ?? null;
      } catch {
        clearTimeout(timeoutId);
        return null;
      }
    } catch {
      return null;
    }
  }

  /** Open a persistent SSE connection and stream events to all subscribers. */
  private async connect(): Promise<void> {
    if (this.abortController) return;

    this.abortController = new AbortController();
    const { signal } = this.abortController;

    try {
      const res = await fetch(`${this.baseUrl}/api/events`, {
        signal,
        headers: { Accept: "text/event-stream" },
      });

      if (!res.ok || !res.body) {
        throw new Error(`SSE connect failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6)) as {
              type: string;
              sessions?: SessionPatch[];
            };
            if (event.type === "snapshot" && event.sessions) {
              this.broadcast(event.sessions);
            }
          } catch {
            // ignore malformed events
          }
        }
      }
    } catch (err) {
      if (signal.aborted) return; // intentional disconnect, not an error
      console.warn("[MuxServer] SSE connection lost:", err instanceof Error ? err.message : err);
    } finally {
      this.abortController = null;
    }

    // Reconnect with backoff if there are still subscribers
    if (this.subscribers.size > 0) {
      console.log("[MuxServer] SSE reconnecting in 5s");
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.subscribers.size > 0) void this.connect();
      }, 5000);
    }
  }

  private disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.abortController?.abort();
    this.abortController = null;
  }
}

// node-pty is an optionalDependency — load dynamically
/* eslint-disable @typescript-eslint/consistent-type-imports -- node-pty is optional; static import would crash if missing */
type IPty = import("node-pty").IPty;
let ptySpawn: typeof import("node-pty").spawn | undefined;
/* eslint-enable @typescript-eslint/consistent-type-imports */
try {
  const nodePty = await import("node-pty");
  ptySpawn = nodePty.spawn;
} catch (err) {
  console.warn("[MuxServer] node-pty not available — mux server will be disabled.", err);
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
 * Create a mux WebSocket server (noServer mode).
 * Returns the WebSocketServer instance for manual upgrade routing.
 */
export function createMuxWebSocket(tmuxPath?: string): WebSocketServer | null {
  if (!ptySpawn) {
    console.warn("[MuxServer] node-pty not available — mux WebSocket will be disabled");
    return null;
  }

  const terminalManager = new TerminalManager(tmuxPath);
  const nextPort = process.env.PORT || "3000";
  const broadcaster = new SessionBroadcaster(nextPort);

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    console.log("[MuxServer] New mux connection");

    const subscriptions = new Map<string, () => void>();
    let sessionUnsubscribe: (() => void) | null = null;
    let missedPongs = 0;
    const MAX_MISSED_PONGS = 3;

    // Heartbeat: send native WebSocket ping every 15s.
    // Browsers automatically respond to native pings with pong frames —
    // no application-level code is needed on the client side.
    const heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        missedPongs += 1;
        if (missedPongs >= MAX_MISSED_PONGS) {
          console.log("[MuxServer] Too many missed pongs, closing connection");
          ws.close(1000, "Heartbeat timeout");
          return;
        }
        ws.ping();
      }
    }, 15_000);

    // Native pong resets the missed counter
    ws.on("pong", () => {
      missedPongs = 0;
    });

    /**
     * Handle incoming messages
     */
    ws.on("message", (data) => {

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
          if (msg.topics.includes("sessions") && !sessionUnsubscribe) {
            sessionUnsubscribe = broadcaster.subscribe((sessions) => {
              if (ws.readyState === WebSocket.OPEN) {
                const snapMsg: ServerMessage = { ch: "sessions", type: "snapshot", sessions };
                ws.send(JSON.stringify(snapMsg));
              }
            });
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
      sessionUnsubscribe?.();
      sessionUnsubscribe = null;
      for (const unsub of subscriptions.values()) {
        unsub();
      }
      subscriptions.clear();
    });

    ws.on("error", (err) => {
      console.error("[MuxServer] WebSocket error:", err.message);
      clearInterval(heartbeatInterval);
      sessionUnsubscribe?.();
      sessionUnsubscribe = null;
      for (const unsub of subscriptions.values()) {
        unsub();
      }
      subscriptions.clear();
    });
  });

  console.log("[MuxServer] Mux WebSocket server created (noServer mode)");
  return wss;
}
