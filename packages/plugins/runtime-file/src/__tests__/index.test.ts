import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { RuntimeHandle } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be set up before import
// ---------------------------------------------------------------------------
const { mockSpawn, mockExecFile } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExecFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    if (cb) cb(null, { stdout: "", stderr: "" });
  }),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
  execFile: mockExecFile,
}));

vi.mock("node:util", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("node:util")>();
  return {
    ...actual,
    promisify: (fn: (...args: unknown[]) => unknown) => {
      if (fn === mockExecFile) {
        return (...args: unknown[]) =>
          new Promise((resolve, reject) => {
            fn(...args, (err: Error | null, result: unknown) => {
              if (err) reject(err);
              else resolve(result);
            });
          });
      }
      return actual.promisify(fn as never);
    },
  };
});

const { mockWatch, mockReadFileSync } = vi.hoisted(() => {
  const mockWatch = vi.fn((_path: string, _opts: unknown, _cb: unknown) => ({
    close: vi.fn(),
    on: vi.fn(),
  }));
  const mockReadFileSync = vi.fn((_path: string, _enc: string) => "");
  return { mockWatch, mockReadFileSync };
});

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(() => ({ write: vi.fn(), end: vi.fn() })),
  existsSync: vi.fn(() => true),
  watch: mockWatch,
  readFileSync: mockReadFileSync,
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  readFile: vi.fn(async () => "{}"),
  chmod: vi.fn(async () => undefined),
}));

vi.mock("../file-transport.js", () => ({
  resolveCommsFiles: vi.fn((_dir: string, sessionId: string) => ({
    dir: `/mock/sessions/${sessionId}/comms`,
    inbox: `/mock/sessions/${sessionId}/comms/inbox`,
    agentEvents: `/mock/sessions/${sessionId}/comms/agent-events`,
    systemEvents: `/mock/sessions/${sessionId}/comms/system-events`,
    heartbeat: `/mock/sessions/${sessionId}/comms/heartbeat`,
  })),
  createCommsFiles: vi.fn(),
  removeCommsFiles: vi.fn(),
  resetCursors: vi.fn(),
  readEpoch: vi.fn(() => 0),
  writeEpoch: vi.fn(),
  initCounters: vi.fn(),
  appendInboxMessage: vi.fn(),
  readNewMessages: vi.fn(() => ({ messages: [], newCursor: 0 })),
  generateDedupKey: vi.fn(() => "test-dedup-1"),
}));

vi.mock("../hooks.js", () => ({
  getHookSettings: vi.fn(() => ({ hooks: {} })),
  INBOX_READER_SCRIPT: "#!/bin/bash\nexit 0",
  STOP_INBOX_CHECK_SCRIPT: "#!/bin/bash\nexit 0",
  PROMPT_INBOX_CHECK_SCRIPT: "#!/bin/bash\nexit 0",
  FILE_TRACKER_SCRIPT: "#!/bin/bash\nexit 0",
}));

import { create, manifest, default as defaultExport } from "../index.js";
import {
  resolveCommsFiles,
  createCommsFiles,
  removeCommsFiles,
  resetCursors,
  appendInboxMessage,
} from "../file-transport.js";

// ---------------------------------------------------------------------------
// Mock ChildProcess
// ---------------------------------------------------------------------------
class MockChildProcess extends EventEmitter {
  pid = 12345;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdin = {
    writable: true,
    write: vi.fn((_data: string, cb: (err?: Error | null) => void) => { cb(null); }),
    once: vi.fn(),
    removeListener: vi.fn(),
    on: vi.fn(),
  };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

function createMockChild(autoSpawn = true): MockChildProcess {
  const child = new MockChildProcess();
  if (autoSpawn) {
    process.nextTick(() => child.emit("spawn"));
  }
  return child;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeHandle(id = "test-session"): RuntimeHandle {
  return { id, runtimeName: "file", data: { pid: 12345 } };
}

function defaultConfig(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "test-session",
    launchCommand: "claude --model opus",
    workspacePath: "/tmp/workspace",
    environment: { FOO: "bar", AO_DATA_DIR: "/mock/sessions", AO_AGENT_NAME: "claude-code" },
    ...overrides,
  };
}

function codexConfig(overrides: Record<string, unknown> = {}) {
  return defaultConfig({
    sessionId: "codex-session",
    launchCommand: "codex --full-auto",
    environment: { AO_DATA_DIR: "/mock/sessions", AO_AGENT_NAME: "codex" },
    ...overrides,
  });
}

function opencodeConfig(overrides: Record<string, unknown> = {}) {
  return defaultConfig({
    sessionId: "opencode-session",
    launchCommand: "opencode run",
    environment: { AO_DATA_DIR: "/mock/sessions", AO_AGENT_NAME: "opencode" },
    ...overrides,
  });
}

function aiderConfig(overrides: Record<string, unknown> = {}) {
  return defaultConfig({
    sessionId: "aider-session",
    launchCommand: "aider --yes",
    environment: { AO_DATA_DIR: "/mock/sessions", AO_AGENT_NAME: "aider" },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// =========================================================================
// Manifest & exports
// =========================================================================
describe("manifest & exports", () => {
  it("has correct manifest fields", () => {
    expect(manifest.name).toBe("file");
    expect(manifest.slot).toBe("runtime");
    expect(manifest.version).toBe("0.1.0");
  });

  it("default export satisfies PluginModule shape", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });

  it("create() returns a Runtime with name 'file'", () => {
    const runtime = create();
    expect(runtime.name).toBe("file");
  });
});

// =========================================================================
// runtime.create() — ALL agents spawn as subprocess
// =========================================================================
describe("create() — subprocess spawning", () => {
  it("sets up comms files for claude-code", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    expect(resolveCommsFiles).toHaveBeenCalledWith("/mock/sessions", "test-session");
    expect(createCommsFiles).toHaveBeenCalledWith(
      expect.objectContaining({ inbox: "/mock/sessions/test-session/comms/inbox" }),
    );
  });

  it("sets up comms files for codex (subprocess, not tmux wrapper)", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(codexConfig());

    expect(resolveCommsFiles).toHaveBeenCalledWith("/mock/sessions", "codex-session");
    expect(createCommsFiles).toHaveBeenCalled();
    // Codex must also spawn via child_process, not tmux
    expect(mockSpawn).toHaveBeenCalled();
  });

  it("sets up comms files for opencode (subprocess)", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(opencodeConfig());

    expect(mockSpawn).toHaveBeenCalled();
    expect(createCommsFiles).toHaveBeenCalled();
  });

  it("sets up comms files for aider (subprocess)", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(aiderConfig());

    expect(mockSpawn).toHaveBeenCalled();
    expect(createCommsFiles).toHaveBeenCalled();
  });

  it("always calls resetCursors on create", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    expect(resetCursors).toHaveBeenCalledWith(
      expect.objectContaining({ inbox: "/mock/sessions/test-session/comms/inbox" }),
    );
  });

  it("always increments epoch (epoch 0 → 1)", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    // readEpoch mock returns 0 by default → epoch should be written as 1
    const runtime = create();
    await runtime.create(defaultConfig());

    const { writeEpoch } = await import("../file-transport.js");
    expect(writeEpoch).toHaveBeenCalledWith("/mock/sessions", "test-session", 1);
  });

  it("injects stream-json flags for claude-code", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig({ launchCommand: "claude --model opus" }));

    const spawnCall = mockSpawn.mock.calls[0][0] as string;
    expect(spawnCall).toContain("-p --input-format stream-json --output-format stream-json --verbose");
  });

  it("injects stream-json flags for full-path claude command", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig({ launchCommand: "/usr/local/bin/claude --model opus" }));

    const spawnCall = mockSpawn.mock.calls[0][0] as string;
    expect(spawnCall).toContain("claude -p --input-format stream-json --output-format stream-json --verbose");
  });

  it("does NOT inject stream-json for codex", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(codexConfig());

    const spawnCall = mockSpawn.mock.calls[0][0] as string;
    expect(spawnCall).toBe("codex --full-auto");
    expect(spawnCall).not.toContain("stream-json");
  });

  it("does NOT inject stream-json for opencode", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(opencodeConfig());

    const spawnCall = mockSpawn.mock.calls[0][0] as string;
    expect(spawnCall).toBe("opencode run");
  });

  it("does NOT inject stream-json for aider", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(aiderConfig());

    const spawnCall = mockSpawn.mock.calls[0][0] as string;
    expect(spawnCall).toBe("aider --yes");
  });

  it("spawns with stdio pipes, shell:true, detached:true for ALL agents", async () => {
    for (const cfg of [defaultConfig(), codexConfig(), opencodeConfig(), aiderConfig()]) {
      vi.clearAllMocks();
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const runtime = create();
      await runtime.create(cfg);

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ shell: true, detached: true, stdio: ["pipe", "pipe", "pipe"] }),
      );
    }
  });

  it("sets AO_INBOX_PATH and AO_AGENT_EVENTS_PATH in spawn env for all agents", async () => {
    for (const cfg of [defaultConfig(), codexConfig(), opencodeConfig(), aiderConfig()]) {
      vi.clearAllMocks();
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const runtime = create();
      await runtime.create(cfg);

      const spawnOpts = mockSpawn.mock.calls[0][1] as { env: Record<string, string> };
      expect(spawnOpts.env.AO_INBOX_PATH).toMatch(/inbox$/);
      expect(spawnOpts.env.AO_AGENT_EVENTS_PATH).toMatch(/agent-events$/);
    }
  });

  it("installs Claude hooks for claude-code only", async () => {
    const { writeFile } = await import("node:fs/promises");

    // claude-code: hooks installed
    vi.clearAllMocks();
    const child1 = createMockChild();
    mockSpawn.mockReturnValue(child1);
    const runtime1 = create();
    await runtime1.create(defaultConfig());
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining("ao-inbox-reader.sh"), expect.any(String), "utf-8",
    );

    // codex: no hooks
    vi.clearAllMocks();
    const child2 = createMockChild();
    mockSpawn.mockReturnValue(child2);
    const runtime2 = create();
    await runtime2.create(codexConfig());
    const hookInstalls = vi.mocked(writeFile).mock.calls.filter(
      (c) => String(c[0]).includes("ao-inbox-reader.sh"),
    );
    expect(hookInstalls).toHaveLength(0);
  });

  it("creates companion tmux session for ALL agents", async () => {
    for (const cfg of [defaultConfig(), codexConfig(), opencodeConfig(), aiderConfig()]) {
      vi.clearAllMocks();
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const runtime = create();
      await runtime.create(cfg);

      const tmuxCalls = mockExecFile.mock.calls.filter(
        (c) => c[0] === "tmux" && c[1].includes("new-session"),
      );
      expect(tmuxCalls.length).toBeGreaterThan(0);
    }
  });

  it("returns handle with runtimeName 'file', matching id, pid and inboxPath in data", async () => {
    const child = createMockChild();
    child.pid = 54321;
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(defaultConfig({ sessionId: "my-session" }));

    expect(handle.id).toBe("my-session");
    expect(handle.runtimeName).toBe("file");
    expect(handle.data.pid).toBe(54321);
    expect(handle.data.inboxPath).toMatch(/inbox/);
    expect(handle.data.agentEventsPath).toMatch(/agent-events/);
  });

  it("throws for invalid session IDs containing slashes", async () => {
    const runtime = create();
    await expect(runtime.create(defaultConfig({ sessionId: "bad/id" }))).rejects.toThrow(
      /Invalid session ID/,
    );
  });

  it("throws for duplicate session IDs", async () => {
    const child1 = createMockChild();
    mockSpawn.mockReturnValue(child1);
    const runtime = create();
    await runtime.create(defaultConfig({ sessionId: "dup-session" }));

    const child2 = createMockChild();
    mockSpawn.mockReturnValue(child2);
    await expect(runtime.create(defaultConfig({ sessionId: "dup-session" }))).rejects.toThrow(
      /already exists/,
    );
  });
});

// =========================================================================
// sendMessage() — inbox-first, per-agent injection
// =========================================================================
describe("sendMessage()", () => {
  it("writes to inbox first, then stdin NDJSON for claude-code (ordering guarantee)", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const callOrder: string[] = [];
    vi.mocked(appendInboxMessage).mockImplementation((..._args: unknown[]) => {
      callOrder.push("appendInboxMessage");
      return undefined as never;
    });
    child.stdin.write = vi.fn((_data: string, cb: (err?: Error | null) => void) => {
      callOrder.push("stdin.write");
      cb(null);
    });

    const runtime = create();
    const handle = await runtime.create(defaultConfig());
    await runtime.sendMessage(handle, "fix the CI failure");

    expect(callOrder[0]).toBe("appendInboxMessage");
    expect(callOrder[1]).toBe("stdin.write");
  });

  it("writes valid NDJSON to stdin for claude-code", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    let capturedData = "";
    child.stdin.write = vi.fn((data: string, cb: (err?: Error | null) => void) => {
      capturedData = data;
      cb(null);
    });

    const runtime = create();
    const handle = await runtime.create(defaultConfig());
    await runtime.sendMessage(handle, "fix the tests");

    expect(capturedData).toMatch(/\n$/);
    const parsed = JSON.parse(capturedData.trim()) as Record<string, unknown>;
    expect(parsed.type).toBe("user");
    expect(parsed.parent_tool_use_id).toBeNull();
    expect(parsed).toHaveProperty("session_id");
    const msg = parsed.message as Record<string, string>;
    expect(msg.role).toBe("user");
    expect(typeof msg.content).toBe("string");
  });

  it("writes to inbox only for codex (no tmux, no NDJSON)", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(codexConfig());
    await runtime.sendMessage(handle, "fix the bug");

    expect(appendInboxMessage).toHaveBeenCalled();
  });

  it("writes to inbox only for opencode (no tmux)", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(opencodeConfig());
    await runtime.sendMessage(handle, "fix the bug");

    expect(appendInboxMessage).toHaveBeenCalled();
  });

  it("writes to inbox only for aider (no tmux)", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(aiderConfig());
    await runtime.sendMessage(handle, "fix the bug");

    expect(appendInboxMessage).toHaveBeenCalled();
  });

  it("throws for unknown session handle", async () => {
    const runtime = create();
    await expect(runtime.sendMessage(makeHandle("nonexistent"), "hello")).rejects.toThrow(
      /No session found/,
    );
  });

  it("throws a clear error wrapping the cause when appendInboxMessage fails (disk full)", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    vi.mocked(appendInboxMessage).mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });

    const runtime = create();
    const handle = await runtime.create(defaultConfig());
    await expect(runtime.sendMessage(handle, "hello")).rejects.toThrow(
      /Failed to write message to inbox/,
    );
  });

  it("silently succeeds when stdin is not writable (inbox still persisted)", async () => {
    const child = createMockChild();
    child.stdin.writable = false;
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(defaultConfig());
    await expect(runtime.sendMessage(handle, "hello")).resolves.toBeUndefined();
    expect(appendInboxMessage).toHaveBeenCalled();
  });
});

// =========================================================================
// getOutput() — in-memory buffer, non-destructive
// =========================================================================
describe("getOutput()", () => {
  it("returns stdout buffer content (non-destructive)", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());
    child.stdout.emit("data", Buffer.from("line one\nline two\n"));

    const output1 = await runtime.getOutput(makeHandle(), 50);
    expect(output1).toBe("line one\nline two");

    // Calling again returns same content (non-destructive)
    const output2 = await runtime.getOutput(makeHandle(), 50);
    expect(output2).toBe("line one\nline two");
  });

  it("respects the lines limit parameter", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());
    child.stdout.emit("data", Buffer.from("a\nb\nc\nd\n"));

    const output = await runtime.getOutput(makeHandle(), 2);
    expect(output).toBe("c\nd");
  });

  it("returns empty string for unknown session", async () => {
    const runtime = create();
    expect(await runtime.getOutput(makeHandle("nonexistent"))).toBe("");
  });

  it("returns stdout buffer for non-claude agents too", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(codexConfig());
    child.stdout.emit("data", Buffer.from("Codex output\n"));

    const output = await runtime.getOutput(handle, 50);
    expect(output).toContain("Codex output");
  });
});

// =========================================================================
// isAlive()
// =========================================================================
describe("isAlive()", () => {
  it("returns true when process is running", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());
    expect(await runtime.isAlive(makeHandle())).toBe(true);
  });

  it("returns false when process has exited", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());
    child.exitCode = 1;
    expect(await runtime.isAlive(makeHandle())).toBe(false);
  });

  it("returns false for unknown session", async () => {
    const runtime = create();
    expect(await runtime.isAlive(makeHandle("nonexistent"))).toBe(false);
  });

  it("isAlive works for all agent types", async () => {
    for (const cfg of [codexConfig(), opencodeConfig(), aiderConfig()]) {
      vi.clearAllMocks();
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const runtime = create();
      const handle = await runtime.create(cfg);
      expect(await runtime.isAlive(handle)).toBe(true);

      child.exitCode = 0;
      expect(await runtime.isAlive(handle)).toBe(false);
    }
  });
});

// =========================================================================
// getMetrics()
// =========================================================================
describe("getMetrics()", () => {
  it("returns uptimeMs for a running session", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());
    await new Promise((r) => setTimeout(r, 10));

    const metrics = await runtime.getMetrics!(makeHandle());
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.uptimeMs).toBeLessThan(5000);
  });
});

// =========================================================================
// getAttachInfo() — companion tmux for all agents
// =========================================================================
describe("getAttachInfo()", () => {
  it("returns tmux attach command for companion session (claude-code)", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    const info = await runtime.getAttachInfo!(makeHandle());
    expect(info.type).toBe("tmux");
    expect(info.target).toBe("test-session");
    expect(info.command).toContain("tmux attach -t");
  });

  it("returns tmux attach command for companion session (codex)", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(codexConfig());

    const info = await runtime.getAttachInfo!(handle);
    expect(info.type).toBe("tmux");
    expect(info.target).toBe("codex-session");
  });

  it("returns tmux attach for opencode and aider companion sessions", async () => {
    for (const cfg of [opencodeConfig(), aiderConfig()]) {
      vi.clearAllMocks();
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const runtime = create();
      const handle = await runtime.create(cfg);
      const info = await runtime.getAttachInfo!(handle);
      expect(info.type).toBe("tmux");
    }
  });
});

// =========================================================================
// destroy()
// =========================================================================
describe("destroy()", () => {
  it("sends SIGTERM to process group and removes comms files", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(defaultConfig());

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const destroyPromise = runtime.destroy(handle);

    await new Promise((r) => setTimeout(r, 10));
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await destroyPromise;

    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGTERM");
    expect(removeCommsFiles).toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("also destroys companion tmux session", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(defaultConfig());

    // Clear execFile calls from create (companion creation)
    mockExecFile.mockClear();

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const destroyPromise = runtime.destroy(handle);

    await new Promise((r) => setTimeout(r, 10));
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await destroyPromise;

    const killSessionCalls = mockExecFile.mock.calls.filter(
      (c) => c[0] === "tmux" && c[1].includes("kill-session"),
    );
    expect(killSessionCalls.length).toBeGreaterThan(0);

    killSpy.mockRestore();
  });

  it("is a no-op for unknown handle", async () => {
    const runtime = create();
    await expect(runtime.destroy(makeHandle("nonexistent"))).resolves.toBeUndefined();
    expect(removeCommsFiles).not.toHaveBeenCalled();
  });
});

describe("inbox sidecar", () => {
  beforeEach(() => {
    mockWatch.mockReset();
    mockWatch.mockImplementation((_path: string, _opts: unknown, _cb: unknown) => ({
      close: vi.fn(),
      on: vi.fn(),
    }));
    mockReadFileSync.mockReset();
    mockReadFileSync.mockReturnValue("");
    delete process.env["AO_DISABLE_INBOX_SIDECAR"];
  });

  it("starts fs.watch on inbox after create()", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    expect(mockWatch).toHaveBeenCalledWith(
      expect.stringContaining("inbox"),
      expect.objectContaining({ persistent: false }),
      expect.any(Function),
    );
  });

  it("does NOT start fs.watch when AO_DISABLE_INBOX_SIDECAR=1", async () => {
    process.env["AO_DISABLE_INBOX_SIDECAR"] = "1";

    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    await runtime.create(defaultConfig());

    expect(mockWatch).not.toHaveBeenCalled();
  });

  it("drain: writes pending inbox entries with id > lastDeliveredId to stdin", async () => {
    let watchCb: (() => void) | null = null;
    mockWatch.mockImplementation((_path: string, _opts: unknown, _cb: unknown) => {
      watchCb = _cb as () => void;
      return { close: vi.fn(), on: vi.fn() };
    });

    // Inbox has two messages; first will be skipped (id=1, same as lastDeliveredId after send)
    const inboxLines = [
      JSON.stringify({ v: 1, id: 1, epoch: 1, ts: "", source: "orchestrator", type: "message", message: "first", dedup: "a" }),
      JSON.stringify({ v: 1, id: 2, epoch: 1, ts: "", source: "orchestrator", type: "message", message: "second", dedup: "b" }),
    ].join("\n") + "\n";
    mockReadFileSync.mockReturnValue(inboxLines);

    // appendInboxMessage returns id=1 for the sendMessage call
    (appendInboxMessage as ReturnType<typeof vi.fn>).mockReturnValue({ id: 1, message: "first" });

    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(defaultConfig());

    // Send first message — bumps lastDeliveredId to 1
    await runtime.sendMessage(handle, "first");

    // Trigger the sidecar watcher (simulates fs.watch firing for a new write)
    expect(watchCb).not.toBeNull();
    watchCb!();

    // Wait for the async delivery chain to settle
    await new Promise((r) => setTimeout(r, 20));

    // stdin.write should have been called for "second" (id=2 > lastDeliveredId=1)
    const writeCalls = (child.stdin.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c[0] as string);
    const deliveredMessages = writeCalls.filter((s) => s.includes("second"));
    expect(deliveredMessages.length).toBeGreaterThan(0);
  });

  it("drain: skips entries already delivered (id <= lastDeliveredId)", async () => {
    let watchCb: (() => void) | null = null;
    mockWatch.mockImplementation((_path: string, _opts: unknown, _cb: unknown) => {
      watchCb = _cb as () => void;
      return { close: vi.fn(), on: vi.fn() };
    });

    // Only message id=1 exists, already delivered by sendMessage
    const inboxLines =
      JSON.stringify({ v: 1, id: 1, epoch: 1, ts: "", source: "orchestrator", type: "message", message: "already-seen", dedup: "a" }) + "\n";
    mockReadFileSync.mockReturnValue(inboxLines);
    (appendInboxMessage as ReturnType<typeof vi.fn>).mockReturnValue({ id: 1, message: "already-seen" });

    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(defaultConfig());

    await runtime.sendMessage(handle, "already-seen");

    const writesBeforeWatch = (child.stdin.write as ReturnType<typeof vi.fn>).mock.calls.length;

    watchCb!();
    await new Promise((r) => setTimeout(r, 20));

    // No extra writes — message was already delivered
    const writesAfterWatch = (child.stdin.write as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(writesAfterWatch).toBe(writesBeforeWatch);
  });

  it("watcher is closed on destroy()", async () => {
    const mockClose = vi.fn();
    mockWatch.mockImplementation((_path: string, _opts: unknown, _cb: unknown) => ({
      close: mockClose,
      on: vi.fn(),
    }));

    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const runtime = create();
    const handle = await runtime.create(defaultConfig());

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const destroyPromise = runtime.destroy(handle);

    await new Promise((r) => setTimeout(r, 10));
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await destroyPromise;

    expect(mockClose).toHaveBeenCalled();
    killSpy.mockRestore();
  });
});
