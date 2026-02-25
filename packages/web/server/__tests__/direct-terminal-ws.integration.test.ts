/**
 * Integration tests for direct-terminal-ws.
 *
 * These start the real server, create real tmux sessions, connect via
 * WebSocket, and verify the full flow works end-to-end — exactly what
 * a user's browser does when opening a terminal on the dashboard.
 *
 * These tests would have caught the PR #58 breakage because:
 * - The server would fail to start (loadConfig crash)
 * - Session resolution would fail (config.dataDir doesn't exist)
 * - WebSocket connections would be rejected (no tmux session match)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { request, type IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import { spawn as ptySpawn } from "node-pty";
import { findTmux } from "../tmux-utils.js";
import { createDirectTerminalServer, type DirectTerminalServer } from "../direct-terminal-ws.js";

const TMUX = findTmux();
const TEST_SESSION = `ao-test-integration-${process.pid}`;
const TEST_HASH_SESSION = `abcdef123456-${TEST_SESSION}`;
const PREFLIGHT_SESSION = `ao-test-pty-preflight-${process.pid}`;

function hasPtySupport(): boolean {
  const env = {
    HOME: process.env.HOME || "/tmp",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    TERM: "xterm-256color",
    SHELL: process.env.SHELL || "/bin/sh",
    USER: process.env.USER || "test",
  } as Record<string, string>;

  try {
    execFileSync(TMUX, ["new-session", "-d", "-s", PREFLIGHT_SESSION, "-x", "80", "-y", "24"], {
      timeout: 5000,
    });

    const probe = ptySpawn(TMUX, ["attach-session", "-t", PREFLIGHT_SESSION], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: env.HOME,
      env,
    });
    probe.kill();
    return true;
  } catch {
    return false;
  } finally {
    try {
      execFileSync(TMUX, ["kill-session", "-t", PREFLIGHT_SESSION], { timeout: 5000 });
    } catch {
      // best-effort cleanup
    }
  }
}

const ptySupported = hasPtySupport();
const describeIfPty = ptySupported ? describe : describe.skip;
let terminal: DirectTerminalServer;
let port: number;

// =============================================================================
// Helpers
// =============================================================================

function httpGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "localhost", port, path, method: "GET", timeout: 3000 },
      (res: IncomingMessage) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function connectWs(sessionId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?session=${sessionId}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WebSocket connect timeout")), 5000);
  });
}

function waitForWsClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
    setTimeout(() => resolve({ code: -1, reason: "timeout" }), 5000);
  });
}

function waitForWsData(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const handler = (data: Buffer | string) => {
      buf += data.toString();
      if (buf.length > 0) {
        ws.off("message", handler);
        resolve(buf);
      }
    };
    ws.on("message", handler);
    setTimeout(() => {
      ws.off("message", handler);
      if (buf.length > 0) resolve(buf);
      else reject(new Error("No data received from terminal"));
    }, timeoutMs);
  });
}

/** Wait for output containing a specific marker string */
function waitForMarker(ws: WebSocket, marker: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const handler = (data: Buffer | string) => {
      buf += data.toString();
      if (buf.includes(marker)) {
        ws.off("message", handler);
        resolve(buf);
      }
    };
    ws.on("message", handler);
    setTimeout(() => { ws.off("message", handler); resolve(buf); }, timeoutMs);
  });
}

// =============================================================================
// Lifecycle
// =============================================================================

beforeAll(() => {
  // Start the server on a random port for all tests (including server creation tests)
  terminal = createDirectTerminalServer(TMUX);
  terminal.server.listen(0);
  const addr = terminal.server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;

  if (!ptySupported) return;

  // Create test tmux sessions
  execFileSync(TMUX, ["new-session", "-d", "-s", TEST_SESSION, "-x", "80", "-y", "24"], { timeout: 5000 });
  execFileSync(TMUX, ["new-session", "-d", "-s", TEST_HASH_SESSION, "-x", "80", "-y", "24"], { timeout: 5000 });
});

afterEach(() => {
  if (!ptySupported) return;
  // Clean up any active sessions from tests
  for (const [, session] of terminal.activeSessions) {
    session.pty.kill();
    session.ws.close();
  }
  terminal.activeSessions.clear();
});

afterAll(() => {
  terminal.shutdown();
  if (!ptySupported) return;

  // Kill test tmux sessions
  try { execFileSync(TMUX, ["kill-session", "-t", TEST_SESSION], { timeout: 5000 }); } catch { /* already dead */ }
  try { execFileSync(TMUX, ["kill-session", "-t", TEST_HASH_SESSION], { timeout: 5000 }); } catch { /* already dead */ }
});

// =============================================================================
// Health endpoint
// =============================================================================

describeIfPty("health endpoint", () => {
  it("GET /health returns 200 with JSON body", async () => {
    const res = await httpGet("/health");

    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty("active");
    expect(data).toHaveProperty("sessions");
  });

  it("health shows 0 active sessions initially", async () => {
    const res = await httpGet("/health");
    const data = JSON.parse(res.body);

    expect(data.active).toBe(0);
    expect(data.sessions).toEqual([]);
  });

  it("health reflects active sessions after WebSocket connection", async () => {
    const ws = await connectWs(TEST_SESSION);
    await waitForWsData(ws);

    const res = await httpGet("/health");
    const data = JSON.parse(res.body);

    expect(data.active).toBe(1);
    expect(data.sessions).toContain(TEST_SESSION);

    ws.close();
  });

  it("health active count matches number of connections", async () => {
    // Create a second tmux session for this test
    const secondSession = `ao-test-health-${process.pid}`;
    execFileSync(TMUX, ["new-session", "-d", "-s", secondSession, "-x", "80", "-y", "24"], { timeout: 5000 });

    try {
      const ws1 = await connectWs(TEST_SESSION);
      await waitForWsData(ws1);
      const ws2 = await connectWs(secondSession);
      await waitForWsData(ws2);

      const res = await httpGet("/health");
      const data = JSON.parse(res.body);

      expect(data.active).toBe(2);
      expect(data.sessions).toContain(TEST_SESSION);
      expect(data.sessions).toContain(secondSession);

      ws1.close();
      ws2.close();
    } finally {
      try { execFileSync(TMUX, ["kill-session", "-t", secondSession], { timeout: 5000 }); } catch { /* */ }
    }
  });

  it("health active count decreases after WebSocket close", async () => {
    const ws = await connectWs(TEST_SESSION);
    await waitForWsData(ws);

    // Verify connected
    let res = await httpGet("/health");
    expect(JSON.parse(res.body).active).toBe(1);

    // Close and wait for cleanup
    ws.close();
    await new Promise((r) => setTimeout(r, 200));

    res = await httpGet("/health");
    expect(JSON.parse(res.body).active).toBe(0);
  });
});

// =============================================================================
// HTTP routing
// =============================================================================

describeIfPty("HTTP routing", () => {
  it("returns 404 for unknown HTTP path", async () => {
    const res = await httpGet("/unknown-path");
    expect(res.status).toBe(404);
  });

  it("returns 404 for root path", async () => {
    const res = await httpGet("/");
    expect(res.status).toBe(404);
  });

  it("returns 404 for /terminal (that's the ttyd server's endpoint)", async () => {
    const res = await httpGet("/terminal");
    expect(res.status).toBe(404);
  });

  it("returns 404 for /ws via HTTP (not WebSocket upgrade)", async () => {
    const res = await httpGet("/ws");
    expect(res.status).toBe(404);
  });
});

// =============================================================================
// WebSocket connection validation
// =============================================================================

describeIfPty("WebSocket connection validation", () => {
  it("rejects connection with no session parameter", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const result = await waitForWsClose(ws);

    expect(result.code).toBe(1008);
    expect(result.reason).toContain("Missing session");
  });

  it("rejects connection with empty session parameter", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?session=`);
    const result = await waitForWsClose(ws);

    // URL searchParams.get("session") returns "" for ?session=, which is falsy
    expect(result.code).toBe(1008);
    expect(result.reason).toContain("Missing session");
  });

  it("rejects connection with path traversal in session ID", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?session=../../../etc/passwd`);
    const result = await waitForWsClose(ws);

    expect(result.code).toBe(1008);
    expect(result.reason).toContain("Invalid session ID");
  });

  it("rejects connection with shell injection in session ID", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?session=test;rm%20-rf%20/`);
    const result = await waitForWsClose(ws);

    expect(result.code).toBe(1008);
    expect(result.reason).toContain("Invalid session ID");
  });

  it("rejects command substitution in session ID", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?session=test$(whoami)`);
    const result = await waitForWsClose(ws);

    expect(result.code).toBe(1008);
    expect(result.reason).toContain("Invalid session ID");
  });

  it("rejects backtick injection in session ID", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?session=test%60id%60`);
    const result = await waitForWsClose(ws);

    expect(result.code).toBe(1008);
    expect(result.reason).toContain("Invalid session ID");
  });

  it("rejects pipe in session ID", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?session=test|cat%20/etc/passwd`);
    const result = await waitForWsClose(ws);

    expect(result.code).toBe(1008);
    expect(result.reason).toContain("Invalid session ID");
  });

  it("rejects forward slash in session ID", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?session=ao/15`);
    const result = await waitForWsClose(ws);

    expect(result.code).toBe(1008);
    expect(result.reason).toContain("Invalid session ID");
  });

  it("rejects spaces in session ID", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?session=ao%2015`);
    const result = await waitForWsClose(ws);

    expect(result.code).toBe(1008);
    expect(result.reason).toContain("Invalid session ID");
  });

  it("rejects connection for nonexistent tmux session", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?session=ao-nonexistent-999`);
    const result = await waitForWsClose(ws);

    expect(result.code).toBe(1008);
    expect(result.reason).toContain("Session not found");
  });

  it("rejects connection for session that doesn't exist in tmux", async () => {
    // Valid format but no such tmux session
    const ws = new WebSocket(`ws://localhost:${port}/ws?session=definitely-not-real-${Date.now()}`);
    const result = await waitForWsClose(ws);

    expect(result.code).toBe(1008);
    expect(result.reason).toContain("Session not found");
  });
});

// =============================================================================
// WebSocket terminal connection — basic
// =============================================================================

describeIfPty("WebSocket terminal connection", () => {
  it("connects to a real tmux session and receives terminal output", async () => {
    const ws = await connectWs(TEST_SESSION);

    // tmux sends terminal init sequences on attach
    const data = await waitForWsData(ws);
    expect(data.length).toBeGreaterThan(0);

    ws.close();
  });

  it("can send input to the terminal and receive echo", async () => {
    const ws = await connectWs(TEST_SESSION);
    await waitForWsData(ws);

    // Send a command — "echo INTEGRATION_TEST_MARKER"
    const marker = `MARKER_${Date.now()}`;
    ws.send(`echo ${marker}\n`);

    const output = await waitForMarker(ws, marker);
    expect(output).toContain(marker);

    ws.close();
  });

  it("handles resize messages without crashing", async () => {
    const ws = await connectWs(TEST_SESSION);
    await waitForWsData(ws);

    // Send resize message (same format xterm.js FitAddon sends)
    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));

    // Verify connection still works after resize
    const marker = `RESIZE_OK_${Date.now()}`;
    ws.send(`echo ${marker}\n`);
    const output = await waitForMarker(ws, marker);
    expect(output).toContain(marker);

    ws.close();
  });

  it("handles multiple resize messages in sequence", async () => {
    const ws = await connectWs(TEST_SESSION);
    await waitForWsData(ws);

    // Rapid resize sequence (simulating window drag)
    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    ws.send(JSON.stringify({ type: "resize", cols: 110, rows: 35 }));
    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));

    // Should still work
    const marker = `MULTI_RESIZE_${Date.now()}`;
    ws.send(`echo ${marker}\n`);
    const output = await waitForMarker(ws, marker);
    expect(output).toContain(marker);

    ws.close();
  });

  it("passes non-resize JSON as terminal input (not intercepted)", async () => {
    const ws = await connectWs(TEST_SESSION);
    await waitForWsData(ws);

    // JSON that doesn't match resize format should pass through as terminal input
    ws.send(JSON.stringify({ type: "not-resize", data: "hello" }));

    // Should not crash — the JSON string is written to the terminal
    const marker = `JSON_PASSTHROUGH_${Date.now()}`;
    ws.send(`echo ${marker}\n`);
    const output = await waitForMarker(ws, marker);
    expect(output).toContain(marker);

    ws.close();
  });

  it("handles incomplete resize JSON gracefully", async () => {
    const ws = await connectWs(TEST_SESSION);
    await waitForWsData(ws);

    // Resize with missing cols — should be treated as terminal input
    ws.send(JSON.stringify({ type: "resize", rows: 40 }));
    // Resize with missing rows
    ws.send(JSON.stringify({ type: "resize", cols: 120 }));

    // Should still work
    const marker = `INCOMPLETE_RESIZE_${Date.now()}`;
    ws.send(`echo ${marker}\n`);
    const output = await waitForMarker(ws, marker);
    expect(output).toContain(marker);

    ws.close();
  });

  it("handles invalid JSON starting with { gracefully", async () => {
    const ws = await connectWs(TEST_SESSION);
    await waitForWsData(ws);

    // Looks like it might be JSON but isn't
    ws.send("{not json at all");

    // Should not crash — treated as terminal input
    const marker = `BADJSON_${Date.now()}`;
    ws.send(`echo ${marker}\n`);
    const output = await waitForMarker(ws, marker);
    expect(output).toContain(marker);

    ws.close();
  });
});

// =============================================================================
// Hash-prefixed session resolution (integration)
// =============================================================================

describeIfPty("hash-prefixed session resolution", () => {
  it("resolves hash-prefixed tmux session by suffix match", async () => {
    // Create a session that only exists with a hash prefix (no exact match)
    const hashOnlySession = `ao-hashtest-${process.pid}`;
    const hashPrefixedName = `deadbeef0123-${hashOnlySession}`;

    execFileSync(TMUX, ["new-session", "-d", "-s", hashPrefixedName, "-x", "80", "-y", "24"], { timeout: 5000 });

    try {
      const ws = await connectWs(hashOnlySession);

      // Should have resolved via hash-prefix match and connected
      const data = await waitForWsData(ws);
      expect(data.length).toBeGreaterThan(0);

      ws.close();
    } finally {
      try { execFileSync(TMUX, ["kill-session", "-t", hashPrefixedName], { timeout: 5000 }); } catch { /* */ }
    }
  });

  it("can send input through hash-resolved session", async () => {
    const hashOnlySession = `ao-hashcmd-${process.pid}`;
    const hashPrefixedName = `cafebabe0123-${hashOnlySession}`;

    execFileSync(TMUX, ["new-session", "-d", "-s", hashPrefixedName, "-x", "80", "-y", "24"], { timeout: 5000 });

    try {
      const ws = await connectWs(hashOnlySession);
      await waitForWsData(ws);

      const marker = `HASH_CMD_${Date.now()}`;
      ws.send(`echo ${marker}\n`);
      const output = await waitForMarker(ws, marker);
      expect(output).toContain(marker);

      ws.close();
    } finally {
      try { execFileSync(TMUX, ["kill-session", "-t", hashPrefixedName], { timeout: 5000 }); } catch { /* */ }
    }
  });

  it("uses user-facing ID (not hash name) as activeSessions key", async () => {
    const hashOnlySession = `ao-hashkey-${process.pid}`;
    const hashPrefixedName = `face12340000-${hashOnlySession}`;

    execFileSync(TMUX, ["new-session", "-d", "-s", hashPrefixedName, "-x", "80", "-y", "24"], { timeout: 5000 });

    try {
      const ws = await connectWs(hashOnlySession);
      await waitForWsData(ws);

      // The activeSessions map should use the user-facing ID, not the hash-prefixed tmux name
      expect(terminal.activeSessions.has(hashOnlySession)).toBe(true);
      expect(terminal.activeSessions.has(hashPrefixedName)).toBe(false);

      ws.close();
    } finally {
      try { execFileSync(TMUX, ["kill-session", "-t", hashPrefixedName], { timeout: 5000 }); } catch { /* */ }
    }
  });

  it("does NOT cross-match ao-1 to hash-ao-15 via prefix", async () => {
    // Create "deadbeef0123-ao-test-15-PID" but NOT "ao-test-1-PID"
    // Connecting as "ao-test-1-PID" should fail (not match ao-test-15-PID)
    const session15 = `ao-crosstest-15-${process.pid}`;
    const hashSession15 = `deadbeef01ab-${session15}`;
    const session1 = `ao-crosstest-1-${process.pid}`;

    execFileSync(TMUX, ["new-session", "-d", "-s", hashSession15, "-x", "80", "-y", "24"], { timeout: 5000 });

    try {
      // ao-crosstest-1-PID should NOT resolve to deadbeef01ab-ao-crosstest-15-PID
      const ws = new WebSocket(`ws://localhost:${port}/ws?session=${session1}`);
      const result = await waitForWsClose(ws);

      expect(result.code).toBe(1008);
      expect(result.reason).toContain("Session not found");
    } finally {
      try { execFileSync(TMUX, ["kill-session", "-t", hashSession15], { timeout: 5000 }); } catch { /* */ }
    }
  });
});

// =============================================================================
// Terminal I/O
// =============================================================================

describeIfPty("terminal I/O", () => {
  it("can run a command and get output", async () => {
    const ws = await connectWs(TEST_SESSION);
    await waitForWsData(ws);

    const marker = `PWD_TEST_${Date.now()}`;
    ws.send(`echo ${marker}_$(pwd | wc -c)\n`);
    const output = await waitForMarker(ws, marker);
    expect(output).toContain(marker);

    ws.close();
  });

  it("handles special terminal characters (Ctrl-C as \\x03)", async () => {
    const ws = await connectWs(TEST_SESSION);
    await waitForWsData(ws);

    // Start a long-running process
    ws.send("sleep 9999\n");
    await new Promise((r) => setTimeout(r, 200));

    // Send Ctrl-C to interrupt it
    ws.send("\x03");
    await new Promise((r) => setTimeout(r, 200));

    // Should be back at the prompt — test by echoing a marker
    const marker = `CTRLC_OK_${Date.now()}`;
    ws.send(`echo ${marker}\n`);
    const output = await waitForMarker(ws, marker);
    expect(output).toContain(marker);

    ws.close();
  });

  it("handles Tab key (\\t) for completion", async () => {
    const ws = await connectWs(TEST_SESSION);
    await waitForWsData(ws);

    // Tab should not crash the connection
    ws.send("ech\t");
    await new Promise((r) => setTimeout(r, 300));

    // Clear with Ctrl-C and verify still working
    ws.send("\x03");
    await new Promise((r) => setTimeout(r, 200));

    const marker = `TAB_OK_${Date.now()}`;
    ws.send(`echo ${marker}\n`);
    const output = await waitForMarker(ws, marker);
    expect(output).toContain(marker);

    ws.close();
  });

  it("handles Enter key (\\r or \\n)", async () => {
    const ws = await connectWs(TEST_SESSION);
    await waitForWsData(ws);

    // Enter via \r (what xterm.js typically sends)
    const marker = `ENTER_TEST_${Date.now()}`;
    ws.send(`echo ${marker}\r`);
    const output = await waitForMarker(ws, marker);
    expect(output).toContain(marker);

    ws.close();
  });

  it("handles empty messages without crashing", async () => {
    const ws = await connectWs(TEST_SESSION);
    await waitForWsData(ws);

    // Send empty string
    ws.send("");

    // Should still work
    const marker = `EMPTY_MSG_${Date.now()}`;
    ws.send(`echo ${marker}\n`);
    const output = await waitForMarker(ws, marker);
    expect(output).toContain(marker);

    ws.close();
  });

  it("handles rapid keystrokes", async () => {
    const ws = await connectWs(TEST_SESSION);
    await waitForWsData(ws);

    // Simulate rapid typing
    const chars = "echo RAPID_TEST\n";
    for (const ch of chars) {
      ws.send(ch);
    }

    const output = await waitForMarker(ws, "RAPID_TEST");
    expect(output).toContain("RAPID_TEST");

    ws.close();
  });

  it("handles multi-line input", async () => {
    const ws = await connectWs(TEST_SESSION);
    await waitForWsData(ws);

    const marker = `MULTILINE_${Date.now()}`;
    ws.send(`echo "line1" && echo "${marker}"\n`);

    const output = await waitForMarker(ws, marker);
    expect(output).toContain("line1");
    expect(output).toContain(marker);

    ws.close();
  });
});

// =============================================================================
// Connection lifecycle
// =============================================================================

describeIfPty("connection lifecycle", () => {
  it("cleans up activeSessions on WebSocket close", async () => {
    // Use a dedicated session to avoid race conditions with afterEach cleanup
    const cleanupSession = `ao-test-cleanup-${process.pid}`;
    execFileSync(TMUX, ["new-session", "-d", "-s", cleanupSession, "-x", "80", "-y", "24"], { timeout: 5000 });

    try {
      const ws = await connectWs(cleanupSession);
      await waitForWsData(ws);

      // Verify the session was registered
      expect(terminal.activeSessions.has(cleanupSession)).toBe(true);

      ws.close();
      await new Promise((r) => setTimeout(r, 300));

      // After close, the session should be cleaned up
      expect(terminal.activeSessions.has(cleanupSession)).toBe(false);
    } finally {
      try { execFileSync(TMUX, ["kill-session", "-t", cleanupSession], { timeout: 5000 }); } catch { /* */ }
    }
  });

  it("tracks session by user-facing ID in activeSessions", async () => {
    const ws = await connectWs(TEST_SESSION);
    await waitForWsData(ws);

    expect(terminal.activeSessions.has(TEST_SESSION)).toBe(true);

    const session = terminal.activeSessions.get(TEST_SESSION);
    expect(session).toBeDefined();
    expect(session!.sessionId).toBe(TEST_SESSION);

    ws.close();
  });

  it("handles rapid connect and disconnect", async () => {
    // Connect and immediately close multiple times
    for (let i = 0; i < 3; i++) {
      const ws = await connectWs(TEST_SESSION);
      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    }

    // Server should still be healthy
    const res = await httpGet("/health");
    expect(res.status).toBe(200);
  });

  it("server stays healthy after connection errors", async () => {
    // Try invalid connection
    const ws = new WebSocket(`ws://localhost:${port}/ws?session=nonexistent-${Date.now()}`);
    await waitForWsClose(ws);

    // Server should still be healthy
    const res = await httpGet("/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).active).toBe(0);
  });

  it("multiple health checks work consistently", async () => {
    // Rapid health checks shouldn't break anything
    const results = await Promise.all([
      httpGet("/health"),
      httpGet("/health"),
      httpGet("/health"),
    ]);

    for (const res of results) {
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(typeof data.active).toBe("number");
    }
  });
});

// =============================================================================
// Server creation
// =============================================================================

describe("server creation", () => {
  it("createDirectTerminalServer returns all expected properties", () => {
    expect(terminal).toHaveProperty("server");
    expect(terminal).toHaveProperty("wss");
    expect(terminal).toHaveProperty("activeSessions");
    expect(terminal).toHaveProperty("shutdown");
    expect(terminal.activeSessions).toBeInstanceOf(Map);
    expect(typeof terminal.shutdown).toBe("function");
  });

  it("can create multiple independent servers", () => {
    const server2 = createDirectTerminalServer(TMUX);
    server2.server.listen(0);
    const addr = server2.server.address();
    const port2 = typeof addr === "object" && addr ? addr.port : 0;

    expect(port2).toBeGreaterThan(0);
    expect(port2).not.toBe(port);

    // Independent activeSessions
    expect(server2.activeSessions).not.toBe(terminal.activeSessions);

    server2.shutdown();
  });
});
