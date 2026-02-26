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
      name: "cmux",
      slot: "terminal",
      description: "Terminal plugin: cmux pane management",
      version: "0.1.0",
    });
  });

  it("create() returns a terminal with name 'cmux'", () => {
    const terminal = create();
    expect(terminal.name).toBe("cmux");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("openSession", () => {
  it("creates a new pane when focus fails", async () => {
    const terminal = create();
    mockExecFileAsync
      .mockRejectedValueOnce(new Error("pane not found")) // focus fails
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // create succeeds

    const session = makeSessionWithHandle("sess-1");
    await terminal.openSession(session);

    expect(mockExecFileAsync).toHaveBeenCalledTimes(2);
    const [cmd, args] = mockExecFileAsync.mock.calls[1];
    expect(cmd).toBe("cmux");
    expect(args).toContain("create");
    expect(args).toContain("tmux-sess-1");
  });

  it("focuses existing pane when focus succeeds", async () => {
    const terminal = create();
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" }); // focus succeeds

    const session = makeSessionWithHandle("sess-1");
    await terminal.openSession(session);

    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockExecFileAsync.mock.calls[0];
    expect(cmd).toBe("cmux");
    expect(args).toContain("focus");
  });

  it("uses session.id when runtimeHandle is null", async () => {
    const terminal = create();
    mockExecFileAsync
      .mockRejectedValueOnce(new Error("no pane"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const session = makeSession({ id: "my-session-id" });
    await terminal.openSession(session);

    const createArgs = mockExecFileAsync.mock.calls[1][1];
    expect(createArgs).toContain("my-session-id");
  });
});

describe("openAll", () => {
  it("opens panes for all sessions", async () => {
    const terminal = create();
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

    const sessions = [makeSessionWithHandle("sess-1"), makeSessionWithHandle("sess-2")];
    await terminal.openAll(sessions);

    // Each session: focus attempt succeeds
    expect(mockExecFileAsync).toHaveBeenCalledTimes(2);
  });

  it("handles empty sessions array", async () => {
    const terminal = create();
    await terminal.openAll([]);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });
});

describe("isSessionOpen", () => {
  it("returns true when pane with matching name exists", async () => {
    const terminal = create();
    mockExecFileAsync.mockResolvedValue({
      stdout: JSON.stringify([{ name: "tmux-sess-1" }]),
      stderr: "",
    });

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(true);
  });

  it("returns false when no pane with matching name exists", async () => {
    const terminal = create();
    mockExecFileAsync.mockResolvedValue({
      stdout: JSON.stringify([{ name: "other" }]),
      stderr: "",
    });

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });

  it("returns false when cmux command fails", async () => {
    const terminal = create();
    mockExecFileAsync.mockRejectedValue(new Error("command not found"));

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });

  it("returns false when output is invalid JSON", async () => {
    const terminal = create();
    mockExecFileAsync.mockResolvedValue({ stdout: "not json", stderr: "" });

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });

  it("returns false when output is not an array", async () => {
    const terminal = create();
    mockExecFileAsync.mockResolvedValue({ stdout: JSON.stringify({}), stderr: "" });

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });

  it("uses session.id when runtimeHandle is null", async () => {
    const terminal = create();
    mockExecFileAsync.mockResolvedValue({
      stdout: JSON.stringify([{ name: "fallback-id" }]),
      stderr: "",
    });

    const session = makeSession({ id: "fallback-id" });
    expect(await terminal.isSessionOpen(session)).toBe(true);
  });
});
