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
  mockGetUpdateCommand: vi.fn((method: string) => {
    if (method === "git") return "ao update";
    return "npm install -g @aoagents/ao@latest";
  }),
}));

vi.mock("../../src/lib/update-check.js", () => ({
  detectInstallMethod: () => mockDetectInstallMethod(),
  checkForUpdate: (...args: unknown[]) => mockCheckForUpdate(...args),
  invalidateCache: () => mockInvalidateCache(),
  getCurrentVersion: () => mockGetCurrentVersion(),
  getUpdateCommand: (...args: unknown[]) => mockGetUpdateCommand(...args),
}));

const { mockPromptConfirm } = vi.hoisted(() => ({
  mockPromptConfirm: vi.fn(async () => false),
}));

vi.mock("../../src/lib/prompts.js", () => ({
  promptConfirm: (...args: unknown[]) => mockPromptConfirm(...args),
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
    mockCheckForUpdate.mockReset();
    mockCheckForUpdate.mockResolvedValue({
      currentVersion: "0.2.2",
      latestVersion: "0.3.0",
      isOutdated: true,
      installMethod: "git" as const,
      recommendedCommand: "ao update",
      checkedAt: new Date().toISOString(),
    });
    mockInvalidateCache.mockReset();
    mockPromptConfirm.mockReset();
    mockPromptConfirm.mockResolvedValue(false);
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
  // Conflicting flags
  // -----------------------------------------------------------------------

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

  describe("--check", () => {
    it("outputs valid JSON with all expected keys", async () => {
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
      expect(parsed).toHaveProperty("checkedAt");
    });

    it("forces a fresh registry fetch (not cached)", async () => {
      await program.parseAsync(["node", "test", "update", "--check"]);

      expect(mockCheckForUpdate).toHaveBeenCalledWith({ force: true });
    });

    it("does not run script-runner or prompts", async () => {
      await program.parseAsync(["node", "test", "update", "--check"]);

      expect(mockExecuteScriptCommand).not.toHaveBeenCalled();
      expect(mockPromptConfirm).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Git install
  // -----------------------------------------------------------------------

  describe("git install", () => {
    beforeEach(() => {
      mockDetectInstallMethod.mockReturnValue("git");
    });

    it("runs the update script with default args", async () => {
      await program.parseAsync(["node", "test", "update"]);
      expect(mockExecuteScriptCommand).toHaveBeenCalledWith("ao-update.sh", []);
    });

    it("passes through --skip-smoke", async () => {
      await program.parseAsync(["node", "test", "update", "--skip-smoke"]);
      expect(mockExecuteScriptCommand).toHaveBeenCalledWith("ao-update.sh", ["--skip-smoke"]);
    });

    it("passes through --smoke-only", async () => {
      await program.parseAsync(["node", "test", "update", "--smoke-only"]);
      expect(mockExecuteScriptCommand).toHaveBeenCalledWith("ao-update.sh", ["--smoke-only"]);
    });

    it("invalidates cache after successful update", async () => {
      await program.parseAsync(["node", "test", "update"]);
      expect(mockInvalidateCache).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // npm-global install
  // -----------------------------------------------------------------------

  describe("npm-global install", () => {
    beforeEach(() => {
      mockDetectInstallMethod.mockReturnValue("npm-global");
      mockCheckForUpdate.mockResolvedValue({
        currentVersion: "0.2.2",
        latestVersion: "0.3.0",
        isOutdated: true,
        installMethod: "npm-global" as const,
        recommendedCommand: "npm install -g @aoagents/ao@latest",
        checkedAt: new Date().toISOString(),
      });
    });

    it("does not run script-runner", async () => {
      await program.parseAsync(["node", "test", "update"]);
      expect(mockExecuteScriptCommand).not.toHaveBeenCalled();
    });

    it("prints already up to date when not outdated", async () => {
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

    it("exits non-zero when registry is unreachable", async () => {
      mockCheckForUpdate.mockResolvedValue({
        currentVersion: "0.2.2",
        latestVersion: null,
        isOutdated: false,
        installMethod: "npm-global" as const,
        recommendedCommand: "npm install -g @aoagents/ao@latest",
        checkedAt: null,
      });

      await expect(
        program.parseAsync(["node", "test", "update"]),
      ).rejects.toThrow("process.exit(1)");

      expect(vi.mocked(console.error)).toHaveBeenCalledWith(
        expect.stringContaining("Could not reach npm registry"),
      );
    });

    it("warns when --skip-smoke is used with npm-global", async () => {
      // Not outdated so it exits early after the warning
      mockCheckForUpdate.mockResolvedValue({
        currentVersion: "0.3.0",
        latestVersion: "0.3.0",
        isOutdated: false,
        installMethod: "npm-global" as const,
        recommendedCommand: "npm install -g @aoagents/ao@latest",
        checkedAt: new Date().toISOString(),
      });

      const logSpy = vi.mocked(console.log);
      await program.parseAsync(["node", "test", "update", "--skip-smoke"]);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("only apply to git source installs"),
      );
    });

    it("forces a fresh registry fetch", async () => {
      await program.parseAsync(["node", "test", "update"]);

      expect(mockCheckForUpdate).toHaveBeenCalledWith({ force: true });
    });
  });

  // -----------------------------------------------------------------------
  // unknown install
  // -----------------------------------------------------------------------

  describe("unknown install", () => {
    beforeEach(() => {
      mockDetectInstallMethod.mockReturnValue("unknown");
    });

    it("prints help message with install method unknown", async () => {
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

    it("shows latest version when available", async () => {
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

      const allOutput = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("0.3.0");
    });

    it("handles registry unreachable gracefully", async () => {
      mockCheckForUpdate.mockResolvedValue({
        currentVersion: "0.2.2",
        latestVersion: null,
        isOutdated: false,
        installMethod: "unknown" as const,
        recommendedCommand: "npm install -g @aoagents/ao@latest",
        checkedAt: null,
      });

      const logSpy = vi.mocked(console.log);
      // Should not throw
      await program.parseAsync(["node", "test", "update"]);

      const allOutput = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("Could not detect install method");
    });

    it("suggests npm install command", async () => {
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

      expect(mockGetUpdateCommand).toHaveBeenCalledWith("npm-global");
    });
  });
});
