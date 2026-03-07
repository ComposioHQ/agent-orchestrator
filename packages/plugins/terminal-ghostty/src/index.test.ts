import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "@composio/ao-core";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

const { mockPlatform } = vi.hoisted(() => ({
  mockPlatform: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

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
  mockPlatform.mockReturnValue("darwin");
});

describe("plugin manifest & exports", () => {
  it("has correct manifest metadata", () => {
    expect(manifest).toEqual({
      name: "ghostty",
      slot: "terminal",
      description: "Terminal plugin: Ghostty terminal management",
      version: "0.1.0",
    });
  });

  it("create() returns a terminal with name 'ghostty'", () => {
    const terminal = create();
    expect(terminal.name).toBe("ghostty");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("openSession", () => {
  it("runs AppleScript on macOS", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
        cb(null, "", "");
      },
    );

    const terminal = create();
    const session = makeSessionWithHandle("sess-1");
    await terminal.openSession(session);

    expect(mockExecFile).toHaveBeenCalled();
    const [cmd] = mockExecFile.mock.calls[0];
    expect(cmd).toBe("osascript");
  });

  it("warns on non-macOS platform", async () => {
    mockPlatform.mockReturnValue("linux");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const terminal = create();
    await terminal.openSession(makeSessionWithHandle("sess-1"));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("only supported on macOS"),
    );
  });

  it("uses session.id when runtimeHandle is null", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
        cb(null, "", "");
      },
    );

    const terminal = create();
    const session = makeSession({ id: "my-session-id" });
    await terminal.openSession(session);

    // The AppleScript should reference the session name
    const scriptArg = mockExecFile.mock.calls[0][1][1];
    expect(scriptArg).toContain("my-session-id");
  });
});

describe("openAll", () => {
  it("does nothing on non-macOS", async () => {
    mockPlatform.mockReturnValue("linux");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const terminal = create();
    await terminal.openAll([makeSessionWithHandle("sess-1")]);

    expect(warnSpy).toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("handles empty sessions array on macOS", async () => {
    const terminal = create();
    await terminal.openAll([]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("opens tabs for all sessions on macOS", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
        cb(null, "", "");
      },
    );

    const terminal = create();
    const sessions = [makeSessionWithHandle("sess-1"), makeSessionWithHandle("sess-2")];
    await terminal.openAll(sessions);

    // Each session generates at least one AppleScript call
    expect(mockExecFile).toHaveBeenCalled();
  });
});

describe("isSessionOpen", () => {
  it("always returns false", async () => {
    const terminal = create();
    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });
});
