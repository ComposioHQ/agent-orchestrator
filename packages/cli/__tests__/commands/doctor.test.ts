import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

const { mockExecuteScriptCommand } = vi.hoisted(() => ({
  mockExecuteScriptCommand: vi.fn(),
}));

vi.mock("../../src/lib/script-runner.js", () => ({
  executeScriptCommand: (...args: unknown[]) => mockExecuteScriptCommand(...args),
}));

import { registerDoctor } from "../../src/commands/doctor.js";

describe("doctor command", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerDoctor(program);
    mockExecuteScriptCommand.mockReset();
    mockExecuteScriptCommand.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the doctor script with no extra args by default", async () => {
    await program.parseAsync(["node", "test", "doctor"]);

    expect(mockExecuteScriptCommand).toHaveBeenCalledWith("ao-doctor.sh", []);
  });

  it("passes through --fix", async () => {
    await program.parseAsync(["node", "test", "doctor", "--fix"]);

    expect(mockExecuteScriptCommand).toHaveBeenCalledWith("ao-doctor.sh", ["--fix"]);
  });
});
