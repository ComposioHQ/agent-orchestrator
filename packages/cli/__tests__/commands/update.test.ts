import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockExecuteScriptCommand } = vi.hoisted(() => ({
  mockExecuteScriptCommand: vi.fn(),
}));

vi.mock("../../src/lib/script-runner.js", () => ({
  executeScriptCommand: (...args: unknown[]) => mockExecuteScriptCommand(...args),
}));

const {
  mockDetectInstallMethod,
  mockCheckForUpdate,
  mockInvalidateCache,
  mockGetCurrentVersion,
  mockGetUpdateCommand,
} = vi.hoisted(() => ({
  mockDetectInstallMethod: vi.fn(() => "git" as const),
  mockCheckForUpdate: vi.fn(async () => ({
    currentVersion: "0.2.2",
    latestVersion: "0.3.0",
    isOutdated: true,
    installMethod: "git" as const,
    recommendedCommand: "ao update",
    checkedAt: new Date().toISOString(),
  })),
  mockInvalidateCache: vi.fn(),
  mockGetCurrentVersion: vi.fn(() => "0.2.2"),
  mockGetUpdateCommand: vi.fn(() => "ao update"),
}));

vi.mock("../../src/lib/update-check.js", () => ({
  detectInstallMethod: () => mockDetectInstallMethod(),
  checkForUpdate: (...args: unknown[]) => mockCheckForUpdate(...args),
  invalidateCache: () => mockInvalidateCache(),
  getCurrentVersion: () => mockGetCurrentVersion(),
  getUpdateCommand: (...args: unknown[]) => mockGetUpdateCommand(...args),
}));

vi.mock("../../src/lib/prompts.js", () => ({
  promptConfirm: vi.fn(async () => false), // default: decline
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
    mockDetectInstallMethod.mockReturnValue("git");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Git install (existing behavior)
  // -----------------------------------------------------------------------

  it("runs the update script for git installs", async () => {
    mockDetectInstallMethod.mockReturnValue("git");
    await program.parseAsync(["node", "test", "update"]);
    expect(mockExecuteScriptCommand).toHaveBeenCalledWith("ao-update.sh", []);
  });

  it("passes through --skip-smoke for git installs", async () => {
    mockDetectInstallMethod.mockReturnValue("git");
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

  // -----------------------------------------------------------------------
  // --check
  // -----------------------------------------------------------------------

  it("outputs JSON for --check", async () => {
    const logSpy = vi.mocked(console.log);
    await program.parseAsync(["node", "test", "update", "--check"]);

    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("currentVersion");
    expect(parsed).toHaveProperty("latestVersion");
    expect(parsed).toHaveProperty("isOutdated");
    expect(parsed).toHaveProperty("installMethod");
    expect(parsed).toHaveProperty("recommendedCommand");
  });

  // -----------------------------------------------------------------------
  // npm-global install
  // -----------------------------------------------------------------------

  it("does not run script-runner for npm-global installs", async () => {
    mockDetectInstallMethod.mockReturnValue("npm-global");
    mockCheckForUpdate.mockResolvedValue({
      currentVersion: "0.2.2",
      latestVersion: "0.3.0",
      isOutdated: true,
      installMethod: "npm-global" as const,
      recommendedCommand: "npm install -g @aoagents/ao@latest",
      checkedAt: new Date().toISOString(),
    });

    await program.parseAsync(["node", "test", "update"]);
    expect(mockExecuteScriptCommand).not.toHaveBeenCalled();
  });

  it("prints already up to date for npm-global when not outdated", async () => {
    mockDetectInstallMethod.mockReturnValue("npm-global");
    mockCheckForUpdate.mockResolvedValue({
      currentVersion: "0.3.0",
      latestVersion: "0.3.0",
      isOutdated: false,
      installMethod: "npm-global" as const,
      recommendedCommand: "npm install -g @aoagents/ao@latest",
      checkedAt: new Date().toISOString(),
    });

    const logSpy = vi.mocked(console.log);
    await program.parseAsync(["node", "test", "update"]);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Already on latest version"),
    );
  });

  // -----------------------------------------------------------------------
  // unknown install
  // -----------------------------------------------------------------------

  it("prints help message for unknown installs", async () => {
    mockDetectInstallMethod.mockReturnValue("unknown");
    mockCheckForUpdate.mockResolvedValue({
      currentVersion: "0.2.2",
      latestVersion: "0.3.0",
      isOutdated: true,
      installMethod: "unknown" as const,
      recommendedCommand: "npm install -g @aoagents/ao@latest",
      checkedAt: new Date().toISOString(),
    });

    const logSpy = vi.mocked(console.log);
    await program.parseAsync(["node", "test", "update"]);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not detect install method"),
    );
    expect(mockExecuteScriptCommand).not.toHaveBeenCalled();
  });
});
