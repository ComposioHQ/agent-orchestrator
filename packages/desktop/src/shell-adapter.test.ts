import { describe, expect, it } from "vitest";
import { buildSpawnSpec } from "./shell-adapter.js";

describe("buildSpawnSpec", () => {
  it("builds powershell spawn spec", () => {
    const spec = buildSpawnSpec({
      profile: "windows-powershell",
      command: "Get-ChildItem",
      cwd: "C:\\repo",
    });
    expect(spec.executable).toBe("powershell.exe");
    expect(spec.args.at(-1)).toBe("Get-ChildItem");
    expect(spec.cwd).toBe("C:\\repo");
  });

  it("builds cmd spawn spec", () => {
    const spec = buildSpawnSpec({
      profile: "cmd",
      command: "dir",
    });
    expect(spec.executable).toBe("cmd.exe");
    expect(spec.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  });

  it("normalizes windows cwd for wsl", () => {
    const spec = buildSpawnSpec({
      profile: "wsl",
      command: "pwd",
      cwd: "C:\\repo\\agent-orchestrator",
      wslDistribution: "Ubuntu",
    });

    expect(spec.executable).toBe("wsl.exe");
    expect(spec.args).toEqual([
      "--distribution",
      "Ubuntu",
      "--cd",
      "/mnt/c/repo/agent-orchestrator",
      "--exec",
      "bash",
      "-lc",
      "pwd",
    ]);
  });
});
