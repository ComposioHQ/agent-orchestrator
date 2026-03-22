import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

const { mockExecuteScriptCommand } = vi.hoisted(() => ({
  mockExecuteScriptCommand: vi.fn(),
}));

vi.mock("../../src/lib/script-runner.js", () => ({
  executeScriptCommand: (...args: unknown[]) => mockExecuteScriptCommand(...args),
}));

import { registerUpdate } from "../../src/commands/update.js";

describe("update command", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerUpdate(program);
    mockExecuteScriptCommand.mockReset();
    mockExecuteScriptCommand.mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the update script with default args", async () => {
    await program.parseAsync(["node", "test", "update"]);

    expect(mockExecuteScriptCommand).toHaveBeenCalledWith("ao-update.sh", []);
  });

  it("passes through --skip-smoke", async () => {
    await program.parseAsync(["node", "test", "update", "--skip-smoke"]);

    expect(mockExecuteScriptCommand).toHaveBeenCalledWith("ao-update.sh", ["--skip-smoke"]);
  });

  it("rejects conflicting smoke flags", async () => {
    await expect(
      program.parseAsync(["node", "test", "update", "--skip-smoke", "--smoke-only"]),
    ).rejects.toThrow("process.exit(1)");

    expect(mockExecuteScriptCommand).not.toHaveBeenCalled();
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(
      "`ao update` does not allow `--skip-smoke` together with `--smoke-only`.",
    );
  });
});
