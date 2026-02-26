import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "@composio/ao-core";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
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
});

describe("plugin manifest & exports", () => {
  it("has correct manifest metadata", () => {
    expect(manifest).toEqual({
      name: "tui",
      slot: "terminal",
      description: "Terminal plugin: in-terminal TUI dashboard via tmux",
      version: "0.1.0",
    });
  });

  it("create() returns a terminal with name 'tui'", () => {
    const terminal = create();
    expect(terminal.name).toBe("tui");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("openSession", () => {
  it("attaches to tmux session when it exists", async () => {
    const terminal = create();

    // has-session succeeds
    mockExecFile.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args.includes("has-session")) {
          cb(null, "", "");
          return;
        }
        // attach-session: simulate piping by resolving immediately
        const child = {
          stdout: { pipe: vi.fn() },
          stderr: { pipe: vi.fn() },
          stdin: null,
        };
        cb(null, "", "");
        return child;
      },
    );

    const session = makeSessionWithHandle("sess-1");
    await terminal.openSession(session);

    // has-session should be called
    const hasSessionCall = mockExecFile.mock.calls.find(
      (c) => c[1]?.includes("has-session"),
    );
    expect(hasSessionCall).toBeDefined();
  });

  it("warns and returns when tmux session does not exist", async () => {
    const terminal = create();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // has-session fails
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args.includes("has-session")) {
          cb(new Error("no session"));
          return;
        }
        cb(null, "", "");
      },
    );

    const session = makeSessionWithHandle("sess-1");
    await terminal.openSession(session);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("does not exist"),
    );
  });

  it("uses session.id when runtimeHandle is null", async () => {
    const terminal = create();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("no session"));
      },
    );

    const session = makeSession({ id: "my-session-id" });
    await terminal.openSession(session);

    const hasSessionCall = mockExecFile.mock.calls.find(
      (c) => c[1]?.includes("has-session"),
    );
    expect(hasSessionCall).toBeDefined();
    expect(hasSessionCall![1]).toContain("my-session-id");
  });
});

describe("openAll", () => {
  it("handles empty sessions array", async () => {
    const terminal = create();
    await terminal.openAll([]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("warns when no valid tmux sessions found", async () => {
    const terminal = create();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("no session"));
      },
    );

    await terminal.openAll([makeSessionWithHandle("sess-1")]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("No valid tmux sessions found"),
    );
  });
});

describe("isSessionOpen", () => {
  it("returns true when tmux client is attached", async () => {
    const terminal = create();
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "/dev/pts/0\n", "");
      },
    );

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(true);
  });

  it("returns false when no clients attached", async () => {
    const terminal = create();
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "", "");
      },
    );

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });

  it("returns false when tmux command fails", async () => {
    const terminal = create();
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("no session"));
      },
    );

    const session = makeSessionWithHandle("sess-1");
    expect(await terminal.isSessionOpen(session)).toBe(false);
  });

  it("uses session.id when runtimeHandle is null", async () => {
    const terminal = create();
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "/dev/pts/0\n", "");
      },
    );

    const session = makeSession({ id: "fallback-id" });
    expect(await terminal.isSessionOpen(session)).toBe(true);
    expect(mockExecFile.mock.calls[0][1]).toContain("fallback-id");
  });
});
