import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcessModule from "node:child_process";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn: mockSpawn,
  };
});

import { formatAttachCommand, runAttachCommand } from "../../src/lib/attach.js";

function makeChild(exitCode = 0): EventEmitter {
  const child = new EventEmitter() as EventEmitter & { stdio?: unknown };
  queueMicrotask(() => {
    child.emit("exit", exitCode);
  });
  return child;
}

beforeEach(() => {
  mockSpawn.mockReset();
  process.env["SHELL"] = "/bin/zsh";
});

describe("runAttachCommand", () => {
  it("formats a structured attach command when available", () => {
    expect(
      formatAttachCommand(
        {
          type: "docker",
          target: "container-1",
          program: "docker",
          args: ["exec", "-it", "container-1", "tmux", "attach", "-t", "tmux-1"],
        },
        "tmux attach -t fallback",
      ),
    ).toBe("'docker' 'exec' '-it' 'container-1' 'tmux' 'attach' '-t' 'tmux-1'");
  });

  it("falls back to the provided command string when no attach info exists", () => {
    expect(formatAttachCommand(null, "tmux attach -t fallback")).toBe("tmux attach -t fallback");
  });

  it("uses structured attach info when program/args are provided", async () => {
    mockSpawn.mockReturnValue(makeChild());

    await runAttachCommand(
      {
        type: "docker",
        target: "container-1",
        program: "docker",
        args: ["exec", "-it", "container-1", "tmux", "attach", "-t", "tmux-1"],
      },
      { program: "tmux", args: ["attach", "-t", "fallback"] },
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      "docker",
      ["exec", "-it", "container-1", "tmux", "attach", "-t", "tmux-1"],
      { stdio: "inherit" },
    );
  });

  it("uses shell -c when only a command string is available", async () => {
    mockSpawn.mockReturnValue(makeChild());

    await runAttachCommand(
      {
        type: "docker",
        target: "container-1",
        command: "docker exec -it container-1 tmux attach -t tmux-1",
      },
      { program: "tmux", args: ["attach", "-t", "fallback"] },
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-c", "docker exec -it container-1 tmux attach -t tmux-1"],
      { stdio: "inherit" },
    );
  });

  it("rejects when the attach process exits non-zero", async () => {
    mockSpawn.mockReturnValue(makeChild(2));

    await expect(
      runAttachCommand(
        {
          type: "docker",
          target: "container-1",
          program: "docker",
          args: ["exec", "-it", "container-1", "tmux", "attach", "-t", "tmux-1"],
        },
        { program: "tmux", args: ["attach", "-t", "fallback"] },
      ),
    ).rejects.toThrow("attach command exited with code 2");
  });
});
