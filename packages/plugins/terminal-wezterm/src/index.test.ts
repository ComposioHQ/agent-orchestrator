import { beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import { manifest, create } from "./index.js";

vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  (mockExecFile as { [k: symbol]: unknown })[Symbol.for("nodejs.util.promisify.custom")] = vi.fn();
  return { execFile: mockExecFile };
});

vi.mock("@composio/ao-core", () => ({
  shellEscape: (value: string) => value,
}));

const mockExecFileCustom = (childProcess.execFile as { [k: symbol]: unknown })[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

function makeSession(id = "app-1") {
  return {
    id,
    projectId: "app",
    status: "working",
    activity: "active",
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
  };
}

describe("terminal-wezterm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has manifest metadata", () => {
    expect(manifest.name).toBe("wezterm");
    expect(manifest.slot).toBe("terminal");
  });

  it("creates terminal instance", () => {
    const terminal = create();
    expect(terminal.name).toBe("wezterm");
  });

  it("does not match substrings (app-1 must not match app-10)", async () => {
    mockExecFileCustom.mockResolvedValueOnce({
      stdout: "pane-1 tab-1 app-10 workspace\n",
      stderr: "",
    });

    const terminal = create();
    await expect(terminal.isSessionOpen(makeSession("app-1"))).resolves.toBe(false);
  });

  it("detects exact token matches from wezterm list output", async () => {
    mockExecFileCustom.mockResolvedValueOnce({
      stdout: "pane-1 tab-1 app-1 workspace\n",
      stderr: "",
    });

    const terminal = create();
    await expect(terminal.isSessionOpen(makeSession("app-1"))).resolves.toBe(true);
  });

  it("returns false for empty output and missing tabs", async () => {
    mockExecFileCustom.mockResolvedValueOnce({ stdout: "", stderr: "" });
    mockExecFileCustom.mockResolvedValueOnce({ stdout: "pane-1 tab-1 app-10 workspace\n", stderr: "" });

    const terminal = create();
    await expect(terminal.isSessionOpen(makeSession("app-1"))).resolves.toBe(false);
    await expect(terminal.isSessionOpen(makeSession("app-1"))).resolves.toBe(false);
  });

  it("does not spawn a new tab when an exact match already exists", async () => {
    mockExecFileCustom.mockResolvedValueOnce({
      stdout: "pane-1 tab-1 app-1 workspace\n",
      stderr: "",
    });

    const terminal = create();
    await terminal.openSession(makeSession("app-1"));

    expect(mockExecFileCustom).toHaveBeenCalledTimes(1);
    expect(mockExecFileCustom).toHaveBeenCalledWith("wezterm", ["cli", "list"], { timeout: 15_000 });
  });
});
