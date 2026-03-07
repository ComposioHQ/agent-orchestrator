import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "@composio/ao-core";

const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
}));

const { mockPlatform } = vi.hoisted(() => ({
  mockPlatform: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn };
});

vi.mock("node:os", () => ({
  platform: mockPlatform,
}));

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
  mockPlatform.mockReturnValue("win32");
});

describe("plugin manifest & exports", () => {
  it("has correct manifest metadata", () => {
    expect(manifest).toEqual({
      name: "windows-terminal",
      slot: "terminal",
      description: "Terminal plugin: Windows Terminal (wt.exe) tab management",
      version: "0.1.0",
    });
  });

  it("create() returns a terminal with name 'windows-terminal'", () => {
    const terminal = create();
    expect(terminal.name).toBe("windows-terminal");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("openSession", () => {
  it("opens a new tab via wt.exe on Windows", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

    const terminal = create();
    const session = makeSessionWithHandle("sess-1");
    await terminal.openSession(session);

    expect(mockExecFileAsync).toHaveBeenCalledOnce();
    const [cmd, args] = mockExecFileAsync.mock.calls[0];
    expect(cmd).toBe("wt.exe");
    expect(args).toContain("nt");
    expect(args).toContain("tmux-sess-1");
  });

  it("warns on non-Windows platform", async () => {
    mockPlatform.mockReturnValue("linux");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const terminal = create();
    await terminal.openSession(makeSessionWithHandle("sess-1"));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("only available on Windows"),
    );
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("uses session.id when runtimeHandle is null", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

    const terminal = create();
    await terminal.openSession(makeSession({ id: "my-session-id" }));

    const args = mockExecFileAsync.mock.calls[0][1];
    expect(args).toContain("my-session-id");
  });
});

describe("openAll", () => {
  it("opens tabs for all sessions on Windows", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

    const terminal = create();
    const sessions = [makeSessionWithHandle("sess-1"), makeSessionWithHandle("sess-2")];
    await terminal.openAll(sessions);

    expect(mockExecFileAsync).toHaveBeenCalledTimes(2);
  });

  it("does nothing on non-Windows", async () => {
    mockPlatform.mockReturnValue("linux");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const terminal = create();
    await terminal.openAll([makeSessionWithHandle("sess-1")]);

    expect(warnSpy).toHaveBeenCalled();
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("handles empty sessions array", async () => {
    const terminal = create();
    await terminal.openAll([]);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });
});

describe("isSessionOpen", () => {
  it("always returns false", async () => {
    const terminal = create();
    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });
});
