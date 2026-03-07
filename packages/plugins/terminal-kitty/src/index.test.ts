import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks — available inside vi.mock factories
// ---------------------------------------------------------------------------
const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn };
});

import { create, manifest, default as defaultExport } from "./index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test-project",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/workspace/test-project",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeSessionWithHandle(id: string): Session {
  return makeSession({
    id,
    runtimeHandle: { id: `tmux-${id}`, runtimeName: "tmux", data: {} },
  });
}

/** Build a kitty ls JSON response with tabs. */
function kittyLsJson(
  windows: Array<{ id: number; title: string; tabs: Array<{ id: number; title: string }> }>,
): string {
  return JSON.stringify(windows);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
});

describe("plugin manifest & exports", () => {
  it("has correct manifest metadata", () => {
    expect(manifest).toEqual({
      name: "kitty",
      slot: "terminal",
      description: "Terminal plugin: Kitty terminal tab management",
      version: "0.1.0",
    });
  });

  it("create() returns a terminal with name 'kitty'", () => {
    const terminal = create();
    expect(terminal.name).toBe("kitty");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

// =========================================================================
// openSession
// =========================================================================
describe("openSession", () => {
  it("launches a new tab when no existing tab found", async () => {
    const terminal = create();
    // kitten @ ls returns empty array
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "kitten" && args[0] === "@" && args[1] === "ls") {
        return Promise.resolve({ stdout: "[]", stderr: "" });
      }
      if (cmd === "kitten" && args[0] === "@" && args[1] === "launch") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.reject(new Error(`Unexpected: ${cmd} ${args.join(" ")}`));
    });

    const session = makeSessionWithHandle("sess-1");
    await terminal.openSession(session);

    // Verify launch was called
    const launchCall = mockExecFileAsync.mock.calls.find(
      (c: string[]) => c[0] === "kitten" && c[1]?.[1] === "launch",
    );
    expect(launchCall).toBeDefined();
    expect(launchCall![1]).toEqual([
      "@",
      "launch",
      "--type=tab",
      "--title",
      "tmux-sess-1",
      "tmux",
      "attach",
      "-t",
      "tmux-sess-1",
    ]);
  });

  it("focuses existing tab when tab with matching title exists", async () => {
    const terminal = create();
    const lsOutput = kittyLsJson([
      {
        id: 1,
        title: "Main",
        tabs: [
          { id: 10, title: "tmux-sess-1" },
          { id: 11, title: "other" },
        ],
      },
    ]);

    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "kitten" && args[1] === "ls") {
        return Promise.resolve({ stdout: lsOutput, stderr: "" });
      }
      if (cmd === "kitten" && args[1] === "focus-tab") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.reject(new Error(`Unexpected: ${cmd} ${args.join(" ")}`));
    });

    const session = makeSessionWithHandle("sess-1");
    await terminal.openSession(session);

    const focusCall = mockExecFileAsync.mock.calls.find(
      (c: string[]) => c[0] === "kitten" && c[1]?.[1] === "focus-tab",
    );
    expect(focusCall).toBeDefined();
    expect(focusCall![1]).toEqual(["@", "focus-tab", "--match", "id:10"]);
  });

  it("uses session.id when runtimeHandle is null", async () => {
    const terminal = create();
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "kitten" && args[1] === "ls") {
        return Promise.resolve({ stdout: "[]", stderr: "" });
      }
      if (cmd === "kitten" && args[1] === "launch") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.reject(new Error(`Unexpected: ${cmd} ${args.join(" ")}`));
    });

    const session = makeSession({ id: "my-session-id" });
    await terminal.openSession(session);

    const launchCall = mockExecFileAsync.mock.calls.find(
      (c: string[]) => c[0] === "kitten" && c[1]?.[1] === "launch",
    );
    expect(launchCall![1]).toContain("my-session-id");
  });

  it("launches new tab when kitten @ ls fails", async () => {
    const terminal = create();
    let launchCalled = false;
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "kitten" && args[1] === "ls") {
        return Promise.reject(new Error("remote control not enabled"));
      }
      if (cmd === "kitten" && args[1] === "launch") {
        launchCalled = true;
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.reject(new Error(`Unexpected: ${cmd} ${args.join(" ")}`));
    });

    const session = makeSessionWithHandle("sess-1");
    await terminal.openSession(session);
    expect(launchCalled).toBe(true);
  });
});

// =========================================================================
// openAll
// =========================================================================
describe("openAll", () => {
  it("opens tabs for all sessions", async () => {
    const terminal = create();
    const launchCalls: string[][] = [];

    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "kitten" && args[1] === "ls") {
        return Promise.resolve({ stdout: "[]", stderr: "" });
      }
      if (cmd === "kitten" && args[1] === "launch") {
        launchCalls.push(args);
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.reject(new Error(`Unexpected: ${cmd} ${args.join(" ")}`));
    });

    const sessions = [makeSessionWithHandle("sess-1"), makeSessionWithHandle("sess-2")];
    await terminal.openAll(sessions);

    expect(launchCalls).toHaveLength(2);
    expect(launchCalls[0]).toContain("tmux-sess-1");
    expect(launchCalls[1]).toContain("tmux-sess-2");
  });

  it("handles empty sessions array", async () => {
    const terminal = create();
    await terminal.openAll([]);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });
});

// =========================================================================
// isSessionOpen
// =========================================================================
describe("isSessionOpen", () => {
  it("returns true when tab with matching title exists", async () => {
    const terminal = create();
    const lsOutput = kittyLsJson([
      {
        id: 1,
        title: "Main",
        tabs: [{ id: 10, title: "tmux-sess-1" }],
      },
    ]);

    mockExecFileAsync.mockResolvedValue({ stdout: lsOutput, stderr: "" });

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(true);
  });

  it("returns false when no tab with matching title exists", async () => {
    const terminal = create();
    const lsOutput = kittyLsJson([
      {
        id: 1,
        title: "Main",
        tabs: [{ id: 10, title: "other-session" }],
      },
    ]);

    mockExecFileAsync.mockResolvedValue({ stdout: lsOutput, stderr: "" });

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });

  it("returns false when kitten @ ls fails", async () => {
    const terminal = create();
    mockExecFileAsync.mockRejectedValue(new Error("command not found"));

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });

  it("returns false when kitten @ ls returns invalid JSON", async () => {
    const terminal = create();
    mockExecFileAsync.mockResolvedValue({ stdout: "not json", stderr: "" });

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });

  it("returns false when kitten @ ls returns empty array", async () => {
    const terminal = create();
    mockExecFileAsync.mockResolvedValue({ stdout: "[]", stderr: "" });

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });

  it("searches across multiple windows", async () => {
    const terminal = create();
    const lsOutput = kittyLsJson([
      {
        id: 1,
        title: "Window 1",
        tabs: [{ id: 10, title: "other" }],
      },
      {
        id: 2,
        title: "Window 2",
        tabs: [{ id: 20, title: "tmux-sess-1" }],
      },
    ]);

    mockExecFileAsync.mockResolvedValue({ stdout: lsOutput, stderr: "" });

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(true);
  });

  it("uses session.id when runtimeHandle is null", async () => {
    const terminal = create();
    const lsOutput = kittyLsJson([
      {
        id: 1,
        title: "Main",
        tabs: [{ id: 10, title: "fallback-id" }],
      },
    ]);

    mockExecFileAsync.mockResolvedValue({ stdout: lsOutput, stderr: "" });

    const session = makeSession({ id: "fallback-id" });
    expect(await terminal.isSessionOpen(session)).toBe(true);
  });
});
