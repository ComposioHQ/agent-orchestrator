import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentLaunchConfig, RuntimeHandle } from "@composio/ao-core";
import { manifest, create } from "./index.js";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", () => {
  const fn = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: vi.fn(),
  });
  return { execFile: fn };
});

const mockExecFile = (childProcess.execFile as unknown as { [k: symbol]: unknown })[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

function makeLaunchConfig(overrides: Partial<AgentLaunchConfig> = {}): AgentLaunchConfig {
  return {
    sessionId: "sess-1",
    projectConfig: {
      name: "my-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "my",
    },
    ...overrides,
  };
}

describe("agent-amazon-q", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has correct manifest", () => {
    expect(manifest.name).toBe("amazon-q");
    expect(manifest.slot).toBe("agent");
  });

  it("builds launch command", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand(makeLaunchConfig({
      prompt: "Implement feature",
      permissions: "skip",
      model: "x-model",
    }));
    expect(cmd).toContain("--prompt 'Implement feature'");
    expect(cmd).toContain("--trust-all-tools");
  });

  it("does not false-positive match iq process names", async () => {
    const agent = create();
    const handle: RuntimeHandle = { id: "sess-1", runtimeName: "tmux", data: {} };

    mockExecFile.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TTY      ARGS\n  123 ttys001 /usr/bin/iq chat\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected command"));
    });

    await expect(agent.isProcessRunning(handle)).resolves.toBe(false);
  });

  it("detects q executable process correctly", async () => {
    const agent = create();
    const handle: RuntimeHandle = { id: "sess-1", runtimeName: "tmux", data: {} };

    mockExecFile.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TTY      ARGS\n  123 ttys001 /usr/local/bin/q chat\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected command"));
    });

    await expect(agent.isProcessRunning(handle)).resolves.toBe(true);
  });
});
