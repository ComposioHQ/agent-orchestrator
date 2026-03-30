import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

const { mockRunRepoScript, mockFindConfigFile } = vi.hoisted(() => ({
  mockRunRepoScript: vi.fn(),
  mockFindConfigFile: vi.fn(),
}));

vi.mock("../../src/lib/script-runner.js", () => ({
  runRepoScript: (...args: unknown[]) => mockRunRepoScript(...args),
}));

vi.mock("@composio/ao-core", () => ({
  findConfigFile: (...args: unknown[]) => mockFindConfigFile(...args),
  getObservabilityBaseDir: () => "/tmp/.agent-orchestrator/observability",
  loadConfig: vi.fn(),
}));

vi.mock("../../src/lib/openclaw-probe.js", () => ({
  detectOpenClawInstallation: vi.fn(),
  validateToken: vi.fn(),
}));

import { registerDoctor } from "../../src/commands/doctor.js";

describe("doctor command", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerDoctor(program);
    mockRunRepoScript.mockReset();
    mockRunRepoScript.mockResolvedValue(0);
    mockFindConfigFile.mockReset();
    mockFindConfigFile.mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the doctor script with no extra args by default", async () => {
    await program.parseAsync(["node", "test", "doctor"]);

    expect(mockRunRepoScript).toHaveBeenCalledWith("ao-doctor.sh", []);
  });

  it("passes through --fix", async () => {
    await program.parseAsync(["node", "test", "doctor", "--fix"]);

    expect(mockRunRepoScript).toHaveBeenCalledWith("ao-doctor.sh", ["--fix"]);
  });
});
