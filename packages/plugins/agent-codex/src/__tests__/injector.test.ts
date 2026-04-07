import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
vi.mock("node:child_process", () => ({ execFile: vi.fn(), execFileSync: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ mtime: new Date(), size: 0 })),
  lstat: vi.fn(async () => ({ isSymbolicLink: () => false })),
  open: vi.fn(async () => ({ read: vi.fn(async () => ({ bytesRead: 0 })), close: vi.fn(async () => {}) })),
}));
vi.mock("node:fs", () => ({ createReadStream: vi.fn(), existsSync: vi.fn(() => false) }));
vi.mock("node:os", () => ({ homedir: vi.fn(() => "/mock/home") }));
vi.mock("node:crypto", () => ({ randomUUID: vi.fn(() => "mock-uuid") }));
vi.mock("@composio/ao-core", async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import("@composio/ao-core")>("@composio/ao-core");
  return {
    ...actual,
    shellEscape: (s: string) => s,
    buildAgentPath: vi.fn(() => "/mock/bin"),
    setupPathWrapperWorkspace: vi.fn(async () => {}),
    readLastActivityEntry: vi.fn(async () => null),
    checkActivityLogState: vi.fn(() => null),
    getActivityFallbackState: vi.fn(() => null),
    recordTerminalActivity: vi.fn(async () => {}),
    readLastJsonlEntry: vi.fn(async () => null),
    normalizeAgentPermissionMode: vi.fn(() => "permissionless"),
    PREFERRED_GH_PATH: "/usr/local/bin/gh",
    DEFAULT_READY_THRESHOLD_MS: 300_000,
    DEFAULT_ACTIVE_WINDOW_MS: 30_000,
  };
});

import { create } from "../index.js";
import type { MessageInjector } from "@composio/ao-core";
import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Fake ChildProcess
// ---------------------------------------------------------------------------
class FakeWritable extends EventEmitter {
  writable = true;
  written: string[] = [];

  write(data: string, cb?: (err?: Error | null) => void): boolean {
    this.written.push(data);
    if (cb) cb(null);
    return true;
  }
}

interface FakeChild {
  stdin: FakeWritable;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: null;
  signalCode: null;
  pid: number;
}

function makeFakeChild(): FakeChild {
  return {
    stdin: new FakeWritable(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    pid: 99999,
  };
}

/** Push a JSON-RPC response to stdout after the current microtask completes. */
function respondOnStdout(child: FakeChild, response: Record<string, unknown>): void {
  setTimeout(() => {
    child.stdout.push(JSON.stringify(response) + "\n");
  }, 0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
});

describe("getProgrammaticCommand()", () => {
  it("preserves the binary path from baseCommand and appends 'app-server'", () => {
    const agent = create();
    expect(agent.getProgrammaticCommand?.("codex --full-auto")).toBe("codex app-server");
    expect(agent.getProgrammaticCommand?.("codex --model gpt-4o --")).toBe("codex app-server");
    expect(agent.getProgrammaticCommand?.("/usr/local/bin/codex")).toBe("/usr/local/bin/codex app-server");
  });
});

describe("createInjector()", () => {
  it("returns null when stdin is missing", () => {
    const agent = create();
    const child = makeFakeChild();
    const noStdin = { ...child, stdin: null } as unknown as ChildProcess;
    expect(agent.createInjector?.(noStdin)).toBeNull();
  });

  it("returns null when stdout is missing", () => {
    const agent = create();
    const child = makeFakeChild();
    const noStdout = { ...child, stdout: null } as unknown as ChildProcess;
    expect(agent.createInjector?.(noStdout)).toBeNull();
  });

  it("returns a MessageInjector when both stdin and stdout exist", () => {
    const agent = create();
    const child = makeFakeChild();
    const injector = agent.createInjector?.(child as unknown as ChildProcess);
    expect(injector).not.toBeNull();
    expect(typeof injector?.initialize).toBe("function");
    expect(typeof injector?.send).toBe("function");
    expect(typeof injector?.close).toBe("function");
  });
});

describe("initialize()", () => {
  it("sends initialize, initialized notification, and thread/start in order", async () => {
    const agent = create();
    const child = makeFakeChild();
    const injector = agent.createInjector?.(child as unknown as ChildProcess) as MessageInjector;

    // Respond to initialize (id:1) then thread/start (id:2)
    child.stdin.write = vi.fn((data: string, cb?: (err?: Error | null) => void) => {
      if (cb) cb(null);
      const parsed = JSON.parse(data.trim()) as Record<string, unknown>;
      if (parsed["id"] === 1) {
        respondOnStdout(child, { jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
      } else if (parsed["id"] === 2) {
        respondOnStdout(child, { jsonrpc: "2.0", id: 2, result: { threadId: "thread-abc" } });
      }
      return true;
    });

    await injector.initialize();

    const calls = (child.stdin.write as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => JSON.parse((c[0] as string).trim()) as Record<string, unknown>,
    );

    // 3 writes: initialize, initialized (notification), thread/start
    expect(calls).toHaveLength(3);
    expect(calls[0]["method"]).toBe("initialize");
    expect(calls[1]["method"]).toBe("initialized");
    expect(calls[1]["id"]).toBeUndefined(); // notification has no id
    expect(calls[2]["method"]).toBe("thread/start");
  });

  it("extracts threadId from result.id if result.threadId is absent", async () => {
    const agent = create();
    const child = makeFakeChild();
    const injector = agent.createInjector?.(child as unknown as ChildProcess) as MessageInjector;

    child.stdin.write = vi.fn((data: string, cb?: (err?: Error | null) => void) => {
      if (cb) cb(null);
      const parsed = JSON.parse(data.trim()) as Record<string, unknown>;
      if (parsed["id"] === 1) respondOnStdout(child, { jsonrpc: "2.0", id: 1, result: {} });
      if (parsed["id"] === 2) respondOnStdout(child, { jsonrpc: "2.0", id: 2, result: { id: "thread-xyz" } });
      return true;
    });

    await injector.initialize();
    // If we can send after initialize, threadId was extracted correctly
    child.stdin.write = vi.fn((data: string, cb?: (err?: Error | null) => void) => {
      if (cb) cb(null);
      const parsed = JSON.parse(data.trim()) as Record<string, unknown>;
      if (parsed["id"]) respondOnStdout(child, { jsonrpc: "2.0", id: parsed["id"], result: {} });
      return true;
    });
    await expect(injector.send("hello")).resolves.toBeUndefined();
  });
});

describe("send()", () => {
  async function makeInitializedInjector() {
    const agent = create();
    const child = makeFakeChild();
    const injector = agent.createInjector?.(child as unknown as ChildProcess) as MessageInjector;

    child.stdin.write = vi.fn((data: string, cb?: (err?: Error | null) => void) => {
      if (cb) cb(null);
      const parsed = JSON.parse(data.trim()) as Record<string, unknown>;
      if (parsed["id"] === 1) respondOnStdout(child, { jsonrpc: "2.0", id: 1, result: {} });
      if (parsed["id"] === 2) respondOnStdout(child, { jsonrpc: "2.0", id: 2, result: { threadId: "thread-abc" } });
      return true;
    });
    await injector.initialize();

    return { injector, child };
  }

  it("sends turn/start with correct threadId and message", async () => {
    const { injector, child } = await makeInitializedInjector();

    const writes: Record<string, unknown>[] = [];
    child.stdin.write = vi.fn((data: string, cb?: (err?: Error | null) => void) => {
      if (cb) cb(null);
      const parsed = JSON.parse(data.trim()) as Record<string, unknown>;
      writes.push(parsed);
      respondOnStdout(child, { jsonrpc: "2.0", id: parsed["id"], result: { ok: true } });
      return true;
    });

    await injector.send("fix the failing tests");

    expect(writes).toHaveLength(1);
    expect(writes[0]["method"]).toBe("turn/start");
    const params = writes[0]["params"] as Record<string, unknown>;
    expect(params["threadId"]).toBe("thread-abc");
    expect((params["input"] as Array<Record<string, unknown>>)[0]["text"]).toBe("fix the failing tests");
  });

  it("throws if called before initialize()", async () => {
    const agent = create();
    const child = makeFakeChild();
    const injector = agent.createInjector?.(child as unknown as ChildProcess) as MessageInjector;

    await expect(injector.send("hello")).rejects.toThrow(/not initialized/);
  });

  it("rejects when server returns JSON-RPC error", async () => {
    const { injector, child } = await makeInitializedInjector();

    child.stdin.write = vi.fn((data: string, cb?: (err?: Error | null) => void) => {
      if (cb) cb(null);
      const parsed = JSON.parse(data.trim()) as Record<string, unknown>;
      respondOnStdout(child, { jsonrpc: "2.0", id: parsed["id"], error: { code: -32000, message: "session not found" } });
      return true;
    });

    await expect(injector.send("hello")).rejects.toThrow(/session not found/);
  });

  it("rejects when stdin write errors", async () => {
    const { injector, child } = await makeInitializedInjector();

    child.stdin.write = vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
      if (cb) cb(new Error("EPIPE: broken pipe"));
      return false;
    });

    await expect(injector.send("hello")).rejects.toThrow(/EPIPE/);
  });
});

describe("close()", () => {
  it("resolves without throwing", async () => {
    const agent = create();
    const child = makeFakeChild();
    const injector = agent.createInjector?.(child as unknown as ChildProcess) as MessageInjector;

    await expect(injector.close()).resolves.toBeUndefined();
  });

  it("is safe to call multiple times", async () => {
    const agent = create();
    const child = makeFakeChild();
    const injector = agent.createInjector?.(child as unknown as ChildProcess) as MessageInjector;

    await injector.close();
    await expect(injector.close()).resolves.toBeUndefined();
  });
});
