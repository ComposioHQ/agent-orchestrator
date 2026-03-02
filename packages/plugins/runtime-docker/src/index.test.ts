import { beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import { manifest, create } from "./index.js";

vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  (execFile as unknown as { [k: symbol]: unknown })[Symbol.for("nodejs.util.promisify.custom")] = vi.fn();
  return { execFile };
});

const execFileCustom = (childProcess.execFile as unknown as { [k: symbol]: unknown })[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

describe("runtime-docker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileCustom.mockResolvedValue({ stdout: "ok\n", stderr: "" });
  });

  it("has manifest metadata", () => {
    expect(manifest.name).toBe("docker");
    expect(manifest.slot).toBe("runtime");
  });

  it("creates runtime", () => {
    const runtime = create();
    expect(runtime.name).toBe("docker");
  });

  it("sendMessage executes full message via sh -lc", async () => {
    const runtime = create();
    const handle = { id: "ao-app-1", runtimeName: "docker", data: {} };

    await runtime.sendMessage(handle, "Fix the CI failures");

    expect(execFileCustom).toHaveBeenCalledWith(
      "docker",
      ["exec", "ao-app-1", "sh", "-lc", "Fix the CI failures"],
      expect.any(Object),
    );
  });

  it("sendMessage is a no-op for blank messages", async () => {
    const runtime = create();
    const handle = { id: "ao-app-1", runtimeName: "docker", data: {} };
    await runtime.sendMessage(handle, "   ");
    expect(execFileCustom).not.toHaveBeenCalled();
  });
});
