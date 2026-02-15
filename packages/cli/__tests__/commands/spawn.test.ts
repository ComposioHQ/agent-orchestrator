import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { mockTmux, mockExec, mockGit, mockConfigRef, mockGetAgent } = vi.hoisted(() => ({
  mockTmux: vi.fn(),
  mockExec: vi.fn(),
  mockGit: vi.fn(),
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockGetAgent: vi.fn(),
}));

vi.mock("../../src/lib/shell.js", () => ({
  tmux: mockTmux,
  exec: mockExec,
  execSilent: vi.fn(),
  git: mockGit,
  gh: vi.fn(),
  getTmuxSessions: async () => {
    const output = await mockTmux("list-sessions", "-F", "#{session_name}");
    if (!output) return [];
    return output.split("\n").filter(Boolean);
  },
  getTmuxActivity: async (session: string) => {
    const output = await mockTmux("display-message", "-t", session, "-p", "#{session_activity}");
    if (!output) return null;
    const ts = parseInt(output, 10);
    return isNaN(ts) ? null : ts * 1000;
  },
}));

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: "",
  }),
}));

vi.mock("@composio/ao-core", async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    loadConfig: () => mockConfigRef.current,
    buildPrompt: actual["buildPrompt"],
    tmuxSendKeys: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../src/lib/plugins.js", () => ({
  getAgent: mockGetAgent,
  getAgentByName: mockGetAgent,
}));

let tmpDir: string;

import { Command } from "commander";
import { registerSpawn, registerBatchSpawn } from "../../src/commands/spawn.js";

let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-spawn-test-"));

  mockConfigRef.current = {
    dataDir: tmpDir,
    worktreeDir: join(tmpDir, "worktrees"),
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

  // Create main repo dir for git operations
  mkdirSync(join(tmpDir, "main-repo"), { recursive: true });

  program = new Command();
  program.exitOverride();
  registerSpawn(program);
  registerBatchSpawn(program);
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  mockTmux.mockReset();
  mockExec.mockReset();
  mockGit.mockReset();
  mockGetAgent.mockReset();
  mockExec.mockResolvedValue({ stdout: "", stderr: "" });
  mockGetAgent.mockReturnValue({
    name: "claude-code",
    processName: "claude",
    getLaunchCommand: () => "unset CLAUDECODE && claude",
    getEnvironment: () => ({}),
    detectActivity: () => "idle",
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("spawn command", () => {
  it("rejects unknown project", async () => {
    await expect(program.parseAsync(["node", "test", "spawn", "nonexistent"])).rejects.toThrow(
      "process.exit(1)",
    );
  });

  it("creates session with correct naming (prefix-N)", async () => {
    // No existing sessions
    mockTmux.mockResolvedValue(null);
    mockGit.mockResolvedValue("main");

    await program.parseAsync(["node", "test", "spawn", "my-app"]);

    // Should have called tmux new-session with "app-1"
    expect(mockExec).toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["new-session", "-d", "-s", "app-1"]),
    );
  });

  it("increments session number based on existing sessions", async () => {
    // Existing sessions: app-1, app-3
    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") {
        return "app-1\napp-3\nother-5";
      }
      return null;
    });
    mockGit.mockResolvedValue("main");

    await program.parseAsync(["node", "test", "spawn", "my-app"]);

    // Next number should be 4 (max of 1,3 + 1)
    expect(mockExec).toHaveBeenCalledWith("tmux", expect.arrayContaining(["-s", "app-4"]));
  });

  it("creates feature branch from issue ID", async () => {
    mockTmux.mockResolvedValue(null);
    mockGit.mockResolvedValue("feat/INT-123");

    await program.parseAsync(["node", "test", "spawn", "my-app", "INT-123"]);

    // Should have created worktree with branch
    expect(mockGit).toHaveBeenCalledWith(
      expect.arrayContaining(["worktree", "add", "-b", "feat/INT-123"]),
      expect.any(String),
    );
  });

  it("creates detached worktree when no issue provided", async () => {
    mockTmux.mockResolvedValue(null);
    // Worktree add succeeds (returns empty string), branch --show-current returns null (detached)
    mockGit.mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree") return "";
      if (args[0] === "branch") return null;
      return "";
    });

    await program.parseAsync(["node", "test", "spawn", "my-app"]);

    expect(mockGit).toHaveBeenCalledWith(
      expect.arrayContaining(["worktree", "add", expect.any(String), "origin/main", "--detach"]),
      expect.any(String),
    );
  });

  it("writes metadata file for new session", async () => {
    mockTmux.mockResolvedValue(null);
    mockGit.mockResolvedValue("feat/INT-100");

    await program.parseAsync(["node", "test", "spawn", "my-app", "INT-100"]);

    const sessionDir = join(tmpDir, "my-app-sessions");
    expect(existsSync(sessionDir)).toBe(true);

    const metaFile = join(sessionDir, "app-1");
    expect(existsSync(metaFile)).toBe(true);

    const content = readFileSync(metaFile, "utf-8");
    expect(content).toContain("branch=feat/INT-100");
    expect(content).toContain("status=spawning");
    expect(content).toContain("project=my-app");
    expect(content).toContain("issue=INT-100");
  });

  it("launches claude-code agent by default", async () => {
    mockTmux.mockResolvedValue(null);
    mockGit.mockResolvedValue("main");

    await program.parseAsync(["node", "test", "spawn", "my-app"]);

    expect(mockExec).toHaveBeenCalledWith("tmux", [
      "send-keys",
      "-t",
      "app-1",
      "-l",
      "unset CLAUDECODE && claude",
    ]);
  });

  it("fetches from remote before creating worktree", async () => {
    mockTmux.mockResolvedValue(null);
    mockGit.mockResolvedValue("main");

    await program.parseAsync(["node", "test", "spawn", "my-app"]);

    expect(mockGit).toHaveBeenCalledWith(["fetch", "origin", "--quiet"], expect.any(String));
  });

  it("sends initial prompt when issue ID is provided", async () => {
    mockTmux.mockResolvedValue(null);
    mockGit.mockResolvedValue("feat/INT-100");

    await program.parseAsync(["node", "test", "spawn", "my-app", "INT-100"]);

    // Prompt is sent via core tmuxSendKeys (handles multi-line via load-buffer)
    const { tmuxSendKeys } = await import("@composio/ao-core");
    expect(tmuxSendKeys).toHaveBeenCalledWith(
      "app-1",
      expect.stringContaining("INT-100"),
    );
  });

  it("outputs SESSION= for scripting", async () => {
    mockTmux.mockResolvedValue(null);
    mockGit.mockResolvedValue("main");

    await program.parseAsync(["node", "test", "spawn", "my-app"]);

    expect(consoleSpy).toHaveBeenCalledWith("SESSION=app-1");
  });
});

describe("batch-spawn command", () => {
  it("rejects unknown project", async () => {
    await expect(
      program.parseAsync(["node", "test", "batch-spawn", "nonexistent", "ISSUE-1"]),
    ).rejects.toThrow("process.exit(1)");
  });

  it("spawns sessions for multiple issues", async () => {
    // Track created sessions so second spawn increments correctly
    const createdSessions: string[] = [];
    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") {
        return createdSessions.length > 0 ? createdSessions.join("\n") : null;
      }
      return null;
    });
    mockGit.mockResolvedValue("feat/branch");
    // Track tmux new-session calls to update our list
    mockExec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "new-session") {
        const sIdx = args.indexOf("-s");
        if (sIdx >= 0) createdSessions.push(args[sIdx + 1]);
      }
      return { stdout: "", stderr: "" };
    });

    await program.parseAsync(["node", "test", "batch-spawn", "my-app", "INT-1", "INT-2"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Created:");
    expect(output).toContain("SESSION=app-1");
    expect(output).toContain("SESSION=app-2");
  });

  it("skips issues that already have sessions (duplicate detection)", async () => {
    // Create existing session metadata
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "app-1"), "branch=feat/INT-100\nissue=INT-100\n");

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      return null;
    });
    mockGit.mockResolvedValue("feat/branch");

    await program.parseAsync(["node", "test", "batch-spawn", "my-app", "INT-100", "INT-200"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Skip INT-100");
    expect(output).toContain("Skipped:");
    // INT-200 should be spawned
    expect(output).toContain("SESSION=app-2");
  });

  it("shows summary with counts", async () => {
    mockTmux.mockResolvedValue(null);
    mockGit.mockResolvedValue("main");

    await program.parseAsync(["node", "test", "batch-spawn", "my-app", "INT-1"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Summary:");
  });
});
