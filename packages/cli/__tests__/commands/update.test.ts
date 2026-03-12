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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the update script with default args", async () => {
    await program.parseAsync(["node", "test", "update"]);

    expect(mockExecuteScriptCommand).toHaveBeenCalledWith("ao-update.sh", []);
  });

  it("passes through smoke flags", async () => {
    await program.parseAsync(["node", "test", "update", "--skip-smoke", "--smoke-only"]);

    expect(mockExecuteScriptCommand).toHaveBeenCalledWith("ao-update.sh", [
      "--skip-smoke",
      "--smoke-only",
    ]);
  });
});
