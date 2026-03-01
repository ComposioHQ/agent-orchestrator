import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "@composio/ao-core";

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

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test-project",
    status: "working",
    branch: "feat/test",
    runtimeHandle: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  } as Session;
}

function makeSessionWithHandle(id: string): Session {
  return makeSession({
    id,
    runtimeHandle: { id: `tmux-${id}`, runtimeName: "tmux", data: {} },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("plugin manifest & exports", () => {
  it("has correct manifest metadata", () => {
    expect(manifest).toEqual({
      name: "zellij",
      slot: "terminal",
      description: "Terminal plugin: Zellij tab management",
      version: "0.1.0",
    });
  });

  it("create() returns a terminal with name 'zellij'", () => {
    const terminal = create();
    expect(terminal.name).toBe("zellij");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("openSession", () => {
  it("creates a new tab when focus fails", async () => {
    mockExecFileAsync
      .mockRejectedValueOnce(new Error("tab not found")) // go-to-tab-name fails
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // new-tab succeeds

    const terminal = create();
    await terminal.openSession(makeSessionWithHandle("sess-1"));

    expect(mockExecFileAsync).toHaveBeenCalledTimes(2);
    const [cmd, args] = mockExecFileAsync.mock.calls[1];
    expect(cmd).toBe("zellij");
    expect(args).toContain("new-tab");
    expect(args).toContain("tmux-sess-1");
  });

  it("focuses existing tab when go-to-tab-name succeeds", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });

    const terminal = create();
    await terminal.openSession(makeSessionWithHandle("sess-1"));

    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockExecFileAsync.mock.calls[0];
    expect(cmd).toBe("zellij");
    expect(args).toContain("go-to-tab-name");
    expect(args).toContain("tmux-sess-1");
  });

  it("uses session.id when runtimeHandle is null", async () => {
    mockExecFileAsync
      .mockRejectedValueOnce(new Error("tab not found"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const terminal = create();
    await terminal.openSession(makeSession({ id: "my-session-id" }));

    const newTabArgs = mockExecFileAsync.mock.calls[1][1];
    expect(newTabArgs).toContain("my-session-id");
  });

  it("passes correct arguments for new-tab with tmux attach", async () => {
    mockExecFileAsync
      .mockRejectedValueOnce(new Error("tab not found"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const terminal = create();
    await terminal.openSession(makeSessionWithHandle("sess-1"));

    const args = mockExecFileAsync.mock.calls[1][1];
    expect(args).toEqual([
      "action",
      "new-tab",
      "--name",
      "tmux-sess-1",
      "--",
      "tmux",
      "attach",
      "-t",
      "tmux-sess-1",
    ]);
  });
});

describe("openAll", () => {
  it("opens tabs for all sessions", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

    const terminal = create();
    const sessions = [makeSessionWithHandle("sess-1"), makeSessionWithHandle("sess-2")];
    await terminal.openAll(sessions);

    // Each session: focus succeeds (1 call each)
    expect(mockExecFileAsync).toHaveBeenCalledTimes(2);
  });

  it("handles empty sessions array", async () => {
    const terminal = create();
    await terminal.openAll([]);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });
});

describe("isSessionOpen", () => {
  it("returns true when go-to-tab-name succeeds", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

    const terminal = create();
    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(true);
  });

  it("returns false when go-to-tab-name fails", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tab not found"));

    const terminal = create();
    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });

  it("uses session.id when runtimeHandle is null", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

    const terminal = create();
    const session = makeSession({ id: "fallback-id" });
    expect(await terminal.isSessionOpen(session)).toBe(true);
    expect(mockExecFileAsync.mock.calls[0][1]).toContain("fallback-id");
  });
});
