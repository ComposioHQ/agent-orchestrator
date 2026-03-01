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

/** Build a wezterm cli list JSON response with panes. */
function weztermListJson(
  panes: Array<{ tab_id: number; pane_id: number; title: string }>,
): string {
  return JSON.stringify(panes);
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
      name: "wezterm",
      slot: "terminal",
      description: "Terminal plugin: WezTerm tab management",
      version: "0.1.0",
    });
  });

  it("create() returns a terminal with name 'wezterm'", () => {
    const terminal = create();
    expect(terminal.name).toBe("wezterm");
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
  it("spawns a new pane when no existing pane found", async () => {
    const terminal = create();
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "wezterm" && args[0] === "cli" && args[1] === "list") {
        return Promise.resolve({ stdout: "[]", stderr: "" });
      }
      if (cmd === "wezterm" && args[0] === "cli" && args[1] === "spawn") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.reject(new Error(`Unexpected: ${cmd} ${args.join(" ")}`));
    });

    const session = makeSessionWithHandle("sess-1");
    await terminal.openSession(session);

    const spawnCall = mockExecFileAsync.mock.calls.find(
      (c: string[]) => c[0] === "wezterm" && c[1]?.[1] === "spawn",
    );
    expect(spawnCall).toBeDefined();
    expect(spawnCall![1]).toEqual([
      "cli",
      "spawn",
      "--",
      "tmux",
      "attach",
      "-t",
      "tmux-sess-1",
    ]);
  });

  it("activates existing tab when pane with matching title exists", async () => {
    const terminal = create();
    const listOutput = weztermListJson([
      { tab_id: 5, pane_id: 100, title: "tmux-sess-1" },
      { tab_id: 6, pane_id: 101, title: "other" },
    ]);

    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "wezterm" && args[1] === "list") {
        return Promise.resolve({ stdout: listOutput, stderr: "" });
      }
      if (cmd === "wezterm" && args[1] === "activate-tab") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.reject(new Error(`Unexpected: ${cmd} ${args.join(" ")}`));
    });

    const session = makeSessionWithHandle("sess-1");
    await terminal.openSession(session);

    const activateCall = mockExecFileAsync.mock.calls.find(
      (c: string[]) => c[0] === "wezterm" && c[1]?.[1] === "activate-tab",
    );
    expect(activateCall).toBeDefined();
    expect(activateCall![1]).toEqual(["cli", "activate-tab", "--tab-id", "5"]);
  });

  it("uses session.id when runtimeHandle is null", async () => {
    const terminal = create();
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "wezterm" && args[1] === "list") {
        return Promise.resolve({ stdout: "[]", stderr: "" });
      }
      if (cmd === "wezterm" && args[1] === "spawn") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.reject(new Error(`Unexpected: ${cmd} ${args.join(" ")}`));
    });

    const session = makeSession({ id: "my-session-id" });
    await terminal.openSession(session);

    const spawnCall = mockExecFileAsync.mock.calls.find(
      (c: string[]) => c[0] === "wezterm" && c[1]?.[1] === "spawn",
    );
    expect(spawnCall![1]).toContain("my-session-id");
  });

  it("spawns new pane when wezterm cli list fails", async () => {
    const terminal = create();
    let spawnCalled = false;
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "wezterm" && args[1] === "list") {
        return Promise.reject(new Error("wezterm not running"));
      }
      if (cmd === "wezterm" && args[1] === "spawn") {
        spawnCalled = true;
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.reject(new Error(`Unexpected: ${cmd} ${args.join(" ")}`));
    });

    const session = makeSessionWithHandle("sess-1");
    await terminal.openSession(session);
    expect(spawnCalled).toBe(true);
  });
});

// =========================================================================
// openAll
// =========================================================================
describe("openAll", () => {
  it("opens panes for all sessions", async () => {
    const terminal = create();
    const spawnCalls: string[][] = [];

    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "wezterm" && args[1] === "list") {
        return Promise.resolve({ stdout: "[]", stderr: "" });
      }
      if (cmd === "wezterm" && args[1] === "spawn") {
        spawnCalls.push(args);
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.reject(new Error(`Unexpected: ${cmd} ${args.join(" ")}`));
    });

    const sessions = [makeSessionWithHandle("sess-1"), makeSessionWithHandle("sess-2")];
    await terminal.openAll(sessions);

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]).toContain("tmux-sess-1");
    expect(spawnCalls[1]).toContain("tmux-sess-2");
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
  it("returns true when pane with matching title exists", async () => {
    const terminal = create();
    const listOutput = weztermListJson([
      { tab_id: 5, pane_id: 100, title: "tmux-sess-1" },
    ]);

    mockExecFileAsync.mockResolvedValue({ stdout: listOutput, stderr: "" });

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(true);
  });

  it("returns false when no pane with matching title exists", async () => {
    const terminal = create();
    const listOutput = weztermListJson([
      { tab_id: 5, pane_id: 100, title: "other-session" },
    ]);

    mockExecFileAsync.mockResolvedValue({ stdout: listOutput, stderr: "" });

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });

  it("returns false when wezterm cli list fails", async () => {
    const terminal = create();
    mockExecFileAsync.mockRejectedValue(new Error("command not found"));

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });

  it("returns false when wezterm cli list returns invalid JSON", async () => {
    const terminal = create();
    mockExecFileAsync.mockResolvedValue({ stdout: "not json", stderr: "" });

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });

  it("returns false when wezterm cli list returns empty array", async () => {
    const terminal = create();
    mockExecFileAsync.mockResolvedValue({ stdout: "[]", stderr: "" });

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });

  it("searches across all panes to find matching title", async () => {
    const terminal = create();
    const listOutput = weztermListJson([
      { tab_id: 5, pane_id: 100, title: "other" },
      { tab_id: 6, pane_id: 101, title: "tmux-sess-1" },
      { tab_id: 7, pane_id: 102, title: "another" },
    ]);

    mockExecFileAsync.mockResolvedValue({ stdout: listOutput, stderr: "" });

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(true);
  });

  it("uses session.id when runtimeHandle is null", async () => {
    const terminal = create();
    const listOutput = weztermListJson([
      { tab_id: 5, pane_id: 100, title: "fallback-id" },
    ]);

    mockExecFileAsync.mockResolvedValue({ stdout: listOutput, stderr: "" });

    const session = makeSession({ id: "fallback-id" });
    expect(await terminal.isSessionOpen(session)).toBe(true);
  });

  it("returns false when response is a non-array JSON", async () => {
    const terminal = create();
    mockExecFileAsync.mockResolvedValue({ stdout: '{"error": "none"}', stderr: "" });

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });
});
