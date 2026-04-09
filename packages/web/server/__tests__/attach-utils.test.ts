import { describe, expect, it } from "vitest";
import { buildAttachSpawnSpec } from "../attach-utils.js";

describe("buildAttachSpawnSpec", () => {
  it("returns program/args unchanged for structured attach info", () => {
    expect(
      buildAttachSpawnSpec({
        type: "docker",
        target: "container-1",
        program: "docker",
        args: ["exec", "-it", "container-1", "tmux", "attach", "-t", "tmux-1"],
      }),
    ).toEqual({
      program: "docker",
      args: ["exec", "-it", "container-1", "tmux", "attach", "-t", "tmux-1"],
    });
  });

  it("wraps command-only attach info with shell -c", () => {
    expect(
      buildAttachSpawnSpec({
        type: "docker",
        target: "container-1",
        command: "docker exec -it container-1 tmux attach -t tmux-1",
      }),
    ).toEqual({
      program: process.env.SHELL || "/bin/sh",
      args: ["-c", "docker exec -it container-1 tmux attach -t tmux-1"],
    });
  });
});
