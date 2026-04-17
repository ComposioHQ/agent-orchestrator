import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

const {
  mockExecFileSync,
  mockExistsSync,
  mockMkdirSync,
  mockUnlinkSync,
  mockWriteFileSync,
  mockLoadConfig,
} = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockLoadConfig: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock("node:fs", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = (await importOriginal()) as typeof import("node:fs");
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  };
});

vi.mock("node:os", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const original = (await importOriginal()) as typeof import("node:os");
  return {
    ...original,
    platform: () => "darwin",
    homedir: () => "/home/testuser",
  };
});

vi.mock("@aoagents/ao-core", () => ({
  loadConfig: () => mockLoadConfig(),
  sanitizeProjectId: (id: string) =>
    id
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-"),
}));

import { registerService } from "../../src/commands/service.js";

describe("service command (CLI)", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    // Reset mocks without clearing them completely
    mockExecFileSync.mockReset();
    mockExistsSync.mockReset();
    mockMkdirSync.mockReset();
    mockUnlinkSync.mockReset();
    mockWriteFileSync.mockReset();
    mockLoadConfig.mockReset();

    // Set default mock behaviors
    mockExecFileSync.mockReturnValue("");
    mockExistsSync.mockReturnValue(false);
    mockMkdirSync.mockReturnValue("");
    mockUnlinkSync.mockReturnValue("");
    mockWriteFileSync.mockImplementation((..._args: unknown[]) => undefined);
    const baseDir = tmpdir();
    tempDir = mkdtempSync(join(baseDir, "ao-service-command-test-"));
    configPath = join(tempDir, "agent-orchestrator.yaml");

    writeFileSync(
      configPath,
      `
port: 3000
defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
projects:
  my-app:
    name: my-app
    repo: owner/repo
    path: ${join(tempDir, "my-app")}
  other-app:
    name: other-app
    repo: owner/other-repo
    path: ${join(tempDir, "other-app")}
`.trim(),
    );

    mockLoadConfig.mockReturnValue({
      configPath,
      projects: {
        "my-app": { path: join(tempDir, "my-app") },
        "other-app": { path: join(tempDir, "other-app") },
      },
    });

    mockExecFileSync.mockReturnValue("");
    mockExistsSync.mockReturnValue(false);
    mockMkdirSync.mockReturnValue("");
    mockWriteFileSync.mockReturnValue("");
    mockUnlinkSync.mockReturnValue("");

    // Stub process.argv for resolveAoBinary
    process.argv[1] = "/usr/local/bin/ao";
    mockExistsSync.mockImplementation((path: string) => path === "/usr/local/bin/ao");

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
  });

  it("installs service for specified project", async () => {
    const program = new Command();
    registerService(program);

    await program.parseAsync(["node", "test", "service", "install", "my-app"]);

    expect(mockWriteFileSync).toHaveBeenCalled();
    expect(mockMkdirSync).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "launchctl",
      ["load", expect.stringContaining("plist")],
      expect.any(Object),
    );
  });

  it("installs service for default project when not specified", async () => {
    const program = new Command();
    registerService(program);

    await program.parseAsync(["node", "test", "service", "install"]);

    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it("shows manual activation when launchctl load fails", async () => {
    const program = new Command();
    registerService(program);

    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "load") throw new Error("load failed");
      return "";
    });

    await program.parseAsync(["node", "test", "service", "install", "my-app"]);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Activate manually:"),
    );
  });

  it("exits with error when project is not found", async () => {
    const program = new Command();
    registerService(program);

    await expect(
      program.parseAsync(["node", "test", "service", "install", "unknown-app"]),
    ).rejects.toThrow("process.exit called");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Unknown project: unknown-app"),
    );
  });

  it("uninstalls service for specified project", async () => {
    const program = new Command();
    registerService(program);

    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".plist")) return true;
      if (path === "/usr/local/bin/ao") return true;
      return false;
    });

    await program.parseAsync(["node", "test", "service", "uninstall", "my-app"]);

    expect(mockUnlinkSync).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "launchctl",
      ["unload", expect.stringContaining("plist")],
      expect.any(Object),
    );
  });

  it("uninstalls service for default project when not specified", async () => {
    const program = new Command();
    registerService(program);

    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".plist")) return true;
      if (path === "/usr/local/bin/ao") return true;
      return false;
    });

    await program.parseAsync(["node", "test", "service", "uninstall"]);

    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it("shows message when service not found during uninstall", async () => {
    const program = new Command();
    registerService(program);

    mockExistsSync.mockReturnValue(false);

    await program.parseAsync(["node", "test", "service", "uninstall", "my-app"]);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("No service found at:"),
    );
  });

  it("checks service status for specified project", async () => {
    const program = new Command();
    registerService(program);

    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".plist")) return true;
      if (path === "/usr/local/bin/ao") return true;
      return false;
    });

    await program.parseAsync(["node", "test", "service", "status", "my-app"]);

    expect(console.log).toHaveBeenCalled();
  });

  it("shows not installed when service not found", async () => {
    const program = new Command();
    registerService(program);

    mockExistsSync.mockReturnValue(false);

    await program.parseAsync(["node", "test", "service", "status", "my-app"]);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Service not installed"),
    );
  });

  it("handles install error gracefully", async () => {
    const program = new Command();
    registerService(program);

    mockWriteFileSync.mockImplementation(() => {
      throw new Error("write failed");
    });

    await expect(
      program.parseAsync(["node", "test", "service", "install", "my-app"]),
    ).rejects.toThrow("process.exit called");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("write failed"),
    );
  });

  it("handles uninstall error gracefully", async () => {
    const program = new Command();
    registerService(program);

    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".plist")) return true;
      if (path === "/usr/local/bin/ao") return true;
      return false;
    });

    mockUnlinkSync.mockImplementation(() => {
      throw new Error("unlink failed");
    });

    await expect(
      program.parseAsync(["node", "test", "service", "uninstall", "my-app"]),
    ).rejects.toThrow("process.exit called");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("unlink failed"),
    );
  });
});
