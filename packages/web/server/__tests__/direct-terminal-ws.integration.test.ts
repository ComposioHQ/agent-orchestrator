/**
 * Integration tests for direct-terminal-ws.
 *
 * Verifies the HTTP server and /mux WebSocket endpoint behaviour.
 * The per-terminal PTY logic (session validation, I/O, resize) is tested
 * via the mux protocol — send { ch:"terminal", type:"open" } and assert the
 * response, mirroring what the browser's MuxProvider does.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { request, type IncomingMessage } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { getSessionsDir, writeMetadata } from "@aoagents/ao-core";
import { findTmux } from "../tmux-utils.js";
import { createDirectTerminalServer, type DirectTerminalServer } from "../direct-terminal-ws.js";
import { issueTerminalAccess, resetTerminalAuthStateForTests } from "../terminal-auth.js";

const TMUX = findTmux();
const TEST_SESSION = `ao-test-integration-${process.pid}`;
const TEST_HASH_SESSION = `abcdef123456-ao-test-hash-${process.pid}`;

let terminal: DirectTerminalServer;
let port: number;
let tempRoot: string;
let projectPath: string;
let configPath: string;
const previousConfigPath = process.env["AO_CONFIG_PATH"];

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

/** Open a raw WebSocket to /mux and wait for the connection to be established. */
function connectMux(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/mux`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WebSocket connect timeout")), 5000);
  });
}

type MuxMessage = Record<string, unknown>;

/** Send a message and wait for the next message matching a predicate. */
function waitForMessage(
  ws: WebSocket,
  predicate: (msg: MuxMessage) => boolean,
  timeoutMs = 3000,
): Promise<MuxMessage> {
  return new Promise((resolve, reject) => {
    const handler = (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as MuxMessage;
        if (predicate(msg)) {
          ws.off("message", handler);
          resolve(msg);
        }
      } catch {
        /* ignore parse errors */
      }
    };
    ws.on("message", handler);
    setTimeout(() => {
      ws.off("message", handler);
      reject(new Error("Timed out waiting for matching message"));
    }, timeoutMs);
  });
}

// =============================================================================
// Lifecycle
// =============================================================================

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "ao-direct-terminal-"));
  projectPath = join(tempRoot, "project");
  mkdirSync(projectPath, { recursive: true });
  configPath = join(tempRoot, "agent-orchestrator.yaml");
  writeFileSync(
    configPath,
    [
      "port: 3000",
      "defaults:",
      "  runtime: tmux",
      "  agent: claude-code",
      "  workspace: worktree",
      "  notifiers: []",
      "projects:",
      "  app:",
      "    name: App",
      `    path: ${JSON.stringify(projectPath)}`,
      '    repo: "acme/app"',
      '    defaultBranch: "main"',
      '    sessionPrefix: "ao"',
      "    scm:",
      '      plugin: "github"',
      "notifiers: {}",
      "notificationRouting:",
      "  urgent: []",
      "  action: []",
      "  warning: []",
      "  info: []",
      "reactions: {}",
      "",
    ].join("\n"),
    "utf-8",
  );
  process.env["AO_CONFIG_PATH"] = configPath;
  resetTerminalAuthStateForTests();

  const sessionsDir = getSessionsDir(configPath, projectPath);
  writeMetadata(sessionsDir, TEST_SESSION, {
    worktree: projectPath,
    branch: "feat/test",
    status: "working",
    tmuxName: TEST_SESSION,
    project: "app",
  });
  writeMetadata(sessionsDir, `ao-test-hash-${process.pid}`, {
    worktree: projectPath,
    branch: "feat/hash",
    status: "working",
    tmuxName: TEST_HASH_SESSION,
    project: "app",
  });

  execFileSync(TMUX, ["new-session", "-d", "-s", TEST_SESSION, "-x", "80", "-y", "24"], {
    timeout: 5000,
  });
  execFileSync(TMUX, ["new-session", "-d", "-s", TEST_HASH_SESSION, "-x", "80", "-y", "24"], {
    timeout: 5000,
  });

  terminal = createDirectTerminalServer(TMUX);
  terminal.server.listen(0);
  const addr = terminal.server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(() => {
  terminal.shutdown();
  try { execFileSync(TMUX, ["kill-session", "-t", TEST_SESSION], { timeout: 5000 }); } catch { /* */ }
  try { execFileSync(TMUX, ["kill-session", "-t", TEST_HASH_SESSION], { timeout: 5000 }); } catch { /* */ }
  resetTerminalAuthStateForTests();
  if (previousConfigPath === undefined) {
    delete process.env["AO_CONFIG_PATH"];
  } else {
    process.env["AO_CONFIG_PATH"] = previousConfigPath;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

// =============================================================================
// Health endpoint
// =============================================================================

describe("health endpoint", () => {
  it("GET /health returns 200 with JSON body", async () => {
    const res = await httpGet("/health");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty("status", "ok");
    expect(data).toHaveProperty("clients");
    expect(typeof data.clients).toBe("number");
  });

  it("reflects connected mux clients count", async () => {
    const ws = await connectMux();

    const res = await httpGet("/health");
    const data = JSON.parse(res.body);
    expect(data.clients).toBeGreaterThanOrEqual(1);

    ws.close();
  });
});

// =============================================================================
// HTTP routing
// =============================================================================

describe("HTTP routing", () => {
  it("returns 404 for unknown path", async () => {
    expect((await httpGet("/unknown")).status).toBe(404);
  });

  it("returns 404 for root path", async () => {
    expect((await httpGet("/")).status).toBe(404);
  });

  it("returns 404 for /ws via HTTP (not WebSocket upgrade)", async () => {
    expect((await httpGet("/ws")).status).toBe(404);
  });
});

// =============================================================================
// WebSocket upgrade routing
// =============================================================================

describe("WebSocket upgrade routing", () => {
  it("accepts connections on /mux", async () => {
    const ws = await connectMux();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("destroys connections on unknown paths", async () => {
    const result = await new Promise<{ code: number }>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      ws.on("close", (code) => resolve({ code }));
      ws.on("error", () => resolve({ code: -1 }));
      setTimeout(() => resolve({ code: -1 }), 3000);
    });
    // socket.destroy() causes the client to see a non-1000 close or error
    expect(result.code).not.toBe(1000);
  });
});

// =============================================================================
// Mux protocol — session open/validation
// =============================================================================

describe("mux terminal open", () => {
  it("sends error response when terminal auth token is missing", async () => {
    const ws = await connectMux();

    ws.send(JSON.stringify({ ch: "terminal", id: TEST_SESSION, type: "open" }));

    const msg = await waitForMessage(ws, (m) => m.ch === "terminal" && m.type === "error");
    expect(String(msg.message)).toMatch(/token|auth/i);

    ws.close();
  });

  it("sends 'opened' response for a valid tmux session", async () => {
    const ws = await connectMux();
    const { token } = issueTerminalAccess(TEST_SESSION);

    ws.send(JSON.stringify({ ch: "terminal", id: TEST_SESSION, type: "open", token }));

    const msg = await waitForMessage(ws, (m) => m.ch === "terminal" && m.type === "opened");
    expect(msg.id).toBe(TEST_SESSION);

    ws.close();
  });

  it("sends error response for nonexistent tmux session", async () => {
    const ws = await connectMux();

    ws.send(JSON.stringify({
      ch: "terminal",
      id: `nonexistent-${Date.now()}`,
      type: "open",
      token: "missing.token",
    }));

    const msg = await waitForMessage(ws, (m) => m.ch === "terminal" && m.type === "error");
    expect(typeof msg.message).toBe("string");

    ws.close();
  });

  it("resolves hash-prefixed tmux session by suffix", async () => {
    const hashOnlyId = `ao-test-hash-${process.pid}`;
    const ws = await connectMux();
    const { token } = issueTerminalAccess(hashOnlyId);

    ws.send(JSON.stringify({ ch: "terminal", id: hashOnlyId, type: "open", token }));

    const msg = await waitForMessage(ws, (m) => m.ch === "terminal" && (m.type === "opened" || m.type === "error"));
    expect(msg.type).toBe("opened");

    ws.close();
  });
});

// =============================================================================
// Mux protocol — cross-connection isolation
// =============================================================================

describe("mux terminal cross-connection isolation", () => {
  it("rejects data from a connection that did not open the terminal", async () => {
    const wsA = await connectMux();
    const wsB = await connectMux();
    const { token } = issueTerminalAccess(TEST_SESSION);

    wsA.send(JSON.stringify({ ch: "terminal", id: TEST_SESSION, type: "open", token }));
    await waitForMessage(wsA, (m) => m.ch === "terminal" && m.type === "opened");

    wsB.send(JSON.stringify({ ch: "terminal", id: TEST_SESSION, type: "data", data: "echo leak\n" }));

    const err = await waitForMessage(wsB, (m) => m.ch === "terminal" && m.type === "error");
    expect(String(err.message)).toMatch(/not opened/i);

    wsA.close();
    wsB.close();
  });

  it("rejects resize from a connection that did not open the terminal", async () => {
    const wsA = await connectMux();
    const wsB = await connectMux();
    const { token } = issueTerminalAccess(TEST_SESSION);

    wsA.send(JSON.stringify({ ch: "terminal", id: TEST_SESSION, type: "open", token }));
    await waitForMessage(wsA, (m) => m.ch === "terminal" && m.type === "opened");

    wsB.send(JSON.stringify({ ch: "terminal", id: TEST_SESSION, type: "resize", cols: 200, rows: 50 }));

    const err = await waitForMessage(wsB, (m) => m.ch === "terminal" && m.type === "error");
    expect(String(err.message)).toMatch(/not opened/i);

    wsA.close();
    wsB.close();
  });

  it("does not deliver terminal data to a connection that did not subscribe", async () => {
    const wsA = await connectMux();
    const wsB = await connectMux();
    const { token } = issueTerminalAccess(TEST_SESSION);

    // Only wsA opens the terminal
    wsA.send(JSON.stringify({ ch: "terminal", id: TEST_SESSION, type: "open", token }));
    await waitForMessage(wsA, (m) => m.ch === "terminal" && m.type === "opened");

    // wsB subscribes to a different channel to avoid connection-level issues
    let bReceivedTerminalData = false;
    wsB.on("message", (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString()) as MuxMessage;
        if (msg.ch === "terminal" && msg.id === TEST_SESSION && msg.type === "data") {
          bReceivedTerminalData = true;
        }
      } catch { /* ignore */ }
    });

    // wsA sends data that produces output
    const marker = `ISOLATE_${Date.now()}`;
    wsA.send(JSON.stringify({ ch: "terminal", id: TEST_SESSION, type: "data", data: `echo ${marker}\n` }));

    // Wait for wsA to see the echo
    await waitForMessage(wsA, (m) => m.ch === "terminal" && m.type === "data", 5000);

    // Give wsB a moment to potentially receive leaked data
    await new Promise((r) => setTimeout(r, 300));

    expect(bReceivedTerminalData).toBe(false);

    wsA.close();
    wsB.close();
  });

  it("allows both connections to independently open and use the same terminal", async () => {
    const wsA = await connectMux();
    const wsB = await connectMux();
    const tokenA = issueTerminalAccess(TEST_SESSION);
    const tokenB = issueTerminalAccess(TEST_SESSION);

    // Both open the same terminal with their own tokens
    wsA.send(JSON.stringify({ ch: "terminal", id: TEST_SESSION, type: "open", token: tokenA.token }));
    await waitForMessage(wsA, (m) => m.ch === "terminal" && m.type === "opened");

    wsB.send(JSON.stringify({ ch: "terminal", id: TEST_SESSION, type: "open", token: tokenB.token }));
    await waitForMessage(wsB, (m) => m.ch === "terminal" && m.type === "opened");

    // Drain initial output on both
    await new Promise((r) => setTimeout(r, 300));

    // wsA sends data — both should receive it
    const markerA = `BOTH_A_${Date.now()}`;
    let aReceived = "";
    let bReceived = "";
    const collectA = (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString()) as MuxMessage;
        if (msg.ch === "terminal" && msg.type === "data") aReceived += msg.data as string;
      } catch { /* */ }
    };
    const collectB = (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString()) as MuxMessage;
        if (msg.ch === "terminal" && msg.type === "data") bReceived += msg.data as string;
      } catch { /* */ }
    };
    wsA.on("message", collectA);
    wsB.on("message", collectB);

    wsA.send(JSON.stringify({ ch: "terminal", id: TEST_SESSION, type: "data", data: `echo ${markerA}\n` }));

    await new Promise((r) => setTimeout(r, 2000));

    wsA.off("message", collectA);
    wsB.off("message", collectB);

    expect(aReceived).toContain(markerA);
    expect(bReceived).toContain(markerA);

    wsA.close();
    wsB.close();
  });
});

// =============================================================================
// Mux protocol — terminal I/O
// =============================================================================

describe("mux terminal I/O", () => {
  it("receives terminal data after open", async () => {
    const ws = await connectMux();
    const { token } = issueTerminalAccess(TEST_SESSION);

    ws.send(JSON.stringify({ ch: "terminal", id: TEST_SESSION, type: "open", token }));
    await waitForMessage(ws, (m) => m.ch === "terminal" && m.type === "opened");

    // tmux sends terminal init sequences on attach — wait for any data
    const dataMsg = await waitForMessage(ws, (m) => m.ch === "terminal" && m.type === "data", 5000);
    expect(typeof dataMsg.data).toBe("string");
    expect((dataMsg.data as string).length).toBeGreaterThan(0);

    ws.close();
  });

  it("can send input and receive echo", async () => {
    const ws = await connectMux();
    const { token } = issueTerminalAccess(TEST_SESSION);

    ws.send(JSON.stringify({ ch: "terminal", id: TEST_SESSION, type: "open", token }));
    await waitForMessage(ws, (m) => m.ch === "terminal" && m.type === "opened");
    // Drain initial output
    await new Promise((r) => setTimeout(r, 300));

    const marker = `MUX_IO_${Date.now()}`;
    ws.send(JSON.stringify({ ch: "terminal", id: TEST_SESSION, type: "data", data: `echo ${marker}\n` }));

    let received = "";
    await new Promise<void>((resolve) => {
      const handler = (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString()) as MuxMessage;
          if (msg.ch === "terminal" && msg.type === "data") {
            received += msg.data as string;
            if (received.includes(marker)) {
              ws.off("message", handler);
              resolve();
            }
          }
        } catch { /* */ }
      };
      ws.on("message", handler);
      setTimeout(() => { ws.off("message", handler); resolve(); }, 4000);
    });

    expect(received).toContain(marker);
    ws.close();
  });

  it("handles resize without error", async () => {
    const ws = await connectMux();
    const { token } = issueTerminalAccess(TEST_SESSION);

    ws.send(JSON.stringify({ ch: "terminal", id: TEST_SESSION, type: "open", token }));
    await waitForMessage(ws, (m) => m.ch === "terminal" && m.type === "opened");

    ws.send(JSON.stringify({ ch: "terminal", id: TEST_SESSION, type: "resize", cols: 120, rows: 40 }));

    // No error message expected
    await new Promise((r) => setTimeout(r, 200));

    const marker = `RESIZE_${Date.now()}`;
    ws.send(JSON.stringify({ ch: "terminal", id: TEST_SESSION, type: "data", data: `echo ${marker}\n` }));

    let received = "";
    await new Promise<void>((resolve) => {
      const handler = (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString()) as MuxMessage;
          if (msg.ch === "terminal" && msg.type === "data") {
            received += msg.data as string;
            if (received.includes(marker)) { ws.off("message", handler); resolve(); }
          }
        } catch { /* */ }
      };
      ws.on("message", handler);
      setTimeout(() => { ws.off("message", handler); resolve(); }, 4000);
    });

    expect(received).toContain(marker);
    ws.close();
  });
});

// =============================================================================
// Mux protocol — system channel
// =============================================================================

describe("mux system channel", () => {
  it("responds to ping with pong", async () => {
    const ws = await connectMux();

    ws.send(JSON.stringify({ ch: "system", type: "ping" }));

    const msg = await waitForMessage(ws, (m) => m.ch === "system" && m.type === "pong");
    expect(msg.ch).toBe("system");

    ws.close();
  });
});

// =============================================================================
// Server creation
// =============================================================================

describe("server creation", () => {
  it("createDirectTerminalServer returns expected properties", () => {
    expect(terminal).toHaveProperty("server");
    expect(terminal).toHaveProperty("shutdown");
    expect(typeof terminal.shutdown).toBe("function");
  });

  it("can create multiple independent servers", () => {
    const server2 = createDirectTerminalServer(TMUX);
    server2.server.listen(0);
    const addr = server2.server.address();
    const port2 = typeof addr === "object" && addr ? addr.port : 0;

    expect(port2).toBeGreaterThan(0);
    expect(port2).not.toBe(port);

    server2.shutdown();
  });
});
