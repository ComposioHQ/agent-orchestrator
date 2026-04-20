import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getProjectBaseDir, getSessionsDir } from "@aoagents/ao-core";

const { mockConfigRef, mockSessionManager } = vi.hoisted(() => ({
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockSessionManager: {
    list: vi.fn(),
    kill: vi.fn(),
    cleanup: vi.fn(),
    restore: vi.fn(),
    remap: vi.fn(),
    get: vi.fn(),
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    send: vi.fn(),
    claimPR: vi.fn(),
  },
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@aoagents/ao-core")>();
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async () => mockSessionManager,
}));

vi.mock("../../src/lib/caller-context.js", () => ({
  isHumanCaller: () => true,
  getCallerType: () => "human",
}));

vi.mock("../../src/lib/prompts.js", () => ({
  promptConfirm: vi.fn().mockResolvedValue(true),
  promptSelect: vi.fn(),
  promptText: vi.fn(),
}));

import { Command } from "commander";
import { registerReset } from "../../src/commands/reset.js";
import { promptConfirm } from "../../src/lib/prompts.js";

let tmpDir: string;
let configPath: string;
let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-reset-test-"));

  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}");

  mockConfigRef.current = {
    configPath,
    port: 3000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: join(tmpDir, "main-repo"),
        defaultBranch: "main",
        sessionPrefix: "app",
      },
    },
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  } as Record<string, unknown>;

  mkdirSync(join(tmpDir, "main-repo"), { recursive: true });

  program = new Command();
  program.exitOverride();
  registerReset(program);
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  mockSessionManager.list.mockReset();
  mockSessionManager.kill.mockReset();

  vi.mocked(promptConfirm).mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ao reset", () => {
  it("removes the project base directory when confirmed", async () => {
    // Create the project base dir with some state
    const baseDir = getProjectBaseDir(configPath, join(tmpDir, "main-repo"));
    const sessionsDir = getSessionsDir(configPath, join(tmpDir, "main-repo"));
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "app-1"), "status=working\n");
    writeFileSync(join(baseDir, ".origin"), configPath);

    mockSessionManager.list.mockResolvedValue([]);

    await program.parseAsync(["node", "ao", "reset", "my-app", "--yes"]);

    expect(existsSync(baseDir)).toBe(false);
  });

  it("shows what will be deleted before confirmation", async () => {
    const sessionsDir = getSessionsDir(configPath, join(tmpDir, "main-repo"));
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "app-1"), "status=working\n");

    mockSessionManager.list.mockResolvedValue([]);

    await program.parseAsync(["node", "ao", "reset", "my-app", "--yes"]);

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("will be deleted");
    expect(output).toContain("my-app");
  });

  it("does nothing when no state exists", async () => {
    mockSessionManager.list.mockResolvedValue([]);

    await program.parseAsync(["node", "ao", "reset", "my-app", "--yes"]);

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("No AO state found");
  });

  it("kills live sessions before wiping state", async () => {
    const baseDir = getProjectBaseDir(configPath, join(tmpDir, "main-repo"));
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, ".origin"), configPath);

    mockSessionManager.list.mockResolvedValue([
      { id: "app-1", projectId: "my-app", status: "working" },
      { id: "app-2", projectId: "my-app", status: "pr_open" },
    ]);
    mockSessionManager.kill.mockResolvedValue({ cleaned: true });

    await program.parseAsync(["node", "ao", "reset", "my-app", "--yes"]);

    expect(mockSessionManager.kill).toHaveBeenCalledTimes(2);
    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1");
    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-2");
  });

  it("respects confirmation denial", async () => {
    const baseDir = getProjectBaseDir(configPath, join(tmpDir, "main-repo"));
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, ".origin"), configPath);

    vi.mocked(promptConfirm).mockResolvedValue(false);
    mockSessionManager.list.mockResolvedValue([]);

    await program.parseAsync(["node", "ao", "reset", "my-app"]);

    // Should NOT have been deleted
    expect(existsSync(baseDir)).toBe(true);
    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("cancelled");
  });

  it("resets all projects with --all flag", async () => {
    // Add a second project
    const config = mockConfigRef.current!;
    (config.projects as Record<string, unknown>)["other-app"] = {
      name: "Other App",
      repo: "org/other-app",
      path: join(tmpDir, "other-repo"),
      defaultBranch: "main",
      sessionPrefix: "oth",
    };
    mkdirSync(join(tmpDir, "other-repo"), { recursive: true });

    // Create base dirs for both projects
    const baseDir1 = getProjectBaseDir(configPath, join(tmpDir, "main-repo"));
    const baseDir2 = getProjectBaseDir(configPath, join(tmpDir, "other-repo"));
    mkdirSync(baseDir1, { recursive: true });
    mkdirSync(baseDir2, { recursive: true });
    writeFileSync(join(baseDir1, ".origin"), configPath);
    writeFileSync(join(baseDir2, ".origin"), configPath);

    mockSessionManager.list.mockResolvedValue([]);

    await program.parseAsync(["node", "ao", "reset", "--all", "--yes"]);

    expect(existsSync(baseDir1)).toBe(false);
    expect(existsSync(baseDir2)).toBe(false);
  });

  it("errors on unknown project", async () => {
    await expect(
      program.parseAsync(["node", "ao", "reset", "nonexistent", "--yes"]),
    ).rejects.toThrow();
  });

  it("supports -p flag for project selection", async () => {
    const baseDir = getProjectBaseDir(configPath, join(tmpDir, "main-repo"));
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, ".origin"), configPath);

    mockSessionManager.list.mockResolvedValue([]);

    await program.parseAsync(["node", "ao", "reset", "-p", "my-app", "--yes"]);

    expect(existsSync(baseDir)).toBe(false);
  });

  it("continues even if session kill fails", async () => {
    const baseDir = getProjectBaseDir(configPath, join(tmpDir, "main-repo"));
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, ".origin"), configPath);

    mockSessionManager.list.mockResolvedValue([
      { id: "app-1", projectId: "my-app", status: "working" },
    ]);
    mockSessionManager.kill.mockRejectedValue(new Error("tmux dead"));

    await program.parseAsync(["node", "ao", "reset", "my-app", "--yes"]);

    // Should still remove the directory despite kill failure
    expect(existsSync(baseDir)).toBe(false);
  });
});
