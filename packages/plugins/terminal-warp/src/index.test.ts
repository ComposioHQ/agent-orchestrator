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
      name: "warp",
      slot: "terminal",
      description: "Terminal plugin: Warp terminal tab management",
      version: "0.1.0",
    });
  });

  it("create() returns a terminal with name 'warp'", () => {
    const terminal = create();
    expect(terminal.name).toBe("warp");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("openSession", () => {
  it("runs AppleScript on macOS", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "", "");
      },
    );

    const terminal = create();
    await terminal.openSession(makeSessionWithHandle("sess-1"));

    expect(mockExecFile).toHaveBeenCalled();
    const [cmd] = mockExecFile.mock.calls[0];
    expect(cmd).toBe("osascript");
  });

  it("uses warp-cli on non-macOS", async () => {
    mockPlatform.mockReturnValue("linux");
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "", "");
      },
    );

    const terminal = create();
    await terminal.openSession(makeSessionWithHandle("sess-1"));

    const [cmd] = mockExecFile.mock.calls[0];
    expect(cmd).toBe("warp-cli");
  });

  it("uses session.id when runtimeHandle is null", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "", "");
      },
    );

    const terminal = create();
    await terminal.openSession(makeSession({ id: "my-session-id" }));

    const scriptArg = mockExecFile.mock.calls[0][1][1];
    expect(scriptArg).toContain("my-session-id");
  });
});

describe("openAll", () => {
  it("opens tabs for all sessions", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "", "");
      },
    );

    const terminal = create();
    const sessions = [makeSessionWithHandle("sess-1"), makeSessionWithHandle("sess-2")];
    await terminal.openAll(sessions);

    expect(mockExecFile).toHaveBeenCalled();
  });

  it("handles empty sessions array", async () => {
    const terminal = create();
    await terminal.openAll([]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe("isSessionOpen", () => {
  it("returns true when tmux client is attached", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "/dev/pts/0\n", "");
      },
    );

    const terminal = create();
    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(true);
  });

  it("returns false when no clients attached", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "", "");
      },
    );

    const terminal = create();
    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });

  it("returns false when tmux command fails", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("no session"));
      },
    );

    const terminal = create();
    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });
});
