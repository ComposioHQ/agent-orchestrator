import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { mockTmux, mockGit, mockGh, mockExec, mockConfigRef } = vi.hoisted(() => ({
  mockTmux: vi.fn(),
  mockGit: vi.fn(),
  mockGh: vi.fn(),
  mockExec: vi.fn(),
  mockConfigRef: { current: null as Record<string, unknown> | null },
}));

vi.mock("../../src/lib/shell.js", () => ({
  tmux: mockTmux,
  exec: mockExec,
  execSilent: vi.fn(),
  git: mockGit,
  gh: mockGh,
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

vi.mock("@agent-orchestrator/core", () => ({
  loadConfig: () => mockConfigRef.current,
}));

let tmpDir: string;

import { Command } from "commander";
import { registerSession } from "../../src/commands/session.js";

let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-session-test-"));

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

  mkdirSync(join(tmpDir, "main-repo"), { recursive: true });

  program = new Command();
  program.exitOverride();
  registerSession(program);
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  mockTmux.mockReset();
  mockGit.mockReset();
  mockGh.mockReset();
  mockExec.mockReset();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("session ls", () => {
  it("shows project name as header", async () => {
    mockTmux.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "ls"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("My App");
  });

  it("shows 'no active sessions' when none exist", async () => {
    mockTmux.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "ls"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("no active sessions");
  });

  it("lists sessions with metadata", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "app-1"), "branch=feat/INT-100\nstatus=working\n");

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") {
        return String(Math.floor(Date.now() / 1000) - 60);
      }
      return null;
    });
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "ls"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("app-1");
    expect(output).toContain("feat/INT-100");
    expect(output).toContain("[working]");
  });

  it("gets live branch from worktree", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "app-1"), "worktree=/tmp/wt\nbranch=old\nstatus=idle\n");

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      return null;
    });
    mockGit.mockResolvedValue("live-branch");

    await program.parseAsync(["node", "test", "session", "ls"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("live-branch");
  });

  it("shows PR URL when available", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "app-1"),
      "branch=fix\nstatus=pr_open\npr=https://github.com/org/repo/pull/42\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      return null;
    });
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "ls"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("https://github.com/org/repo/pull/42");
  });
});

describe("session kill", () => {
  it("rejects unknown session (no matching project)", async () => {
    await expect(
      program.parseAsync(["node", "test", "session", "kill", "unknown-1"]),
    ).rejects.toThrow("process.exit(1)");
  });

  it("kills tmux session and archives metadata", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "app-1"), "worktree=/tmp/wt\nbranch=feat/fix\nstatus=working\n");

    mockTmux.mockResolvedValue("");
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "kill", "app-1"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Killed tmux session: app-1");
    expect(output).toContain("Archived metadata");

    // Original file should be gone, archive should exist
    expect(existsSync(join(sessionDir, "app-1"))).toBe(false);
    const archiveDir = join(sessionDir, "archive");
    expect(existsSync(archiveDir)).toBe(true);
    const archived = readdirSync(archiveDir);
    expect(archived.length).toBe(1);
    expect(archived[0]).toMatch(/^app-1_/);
  });

  it("removes worktree when metadata has worktree path", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "app-1"), "worktree=/tmp/test-wt\nbranch=main\n");

    mockTmux.mockResolvedValue("");
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "kill", "app-1"]);

    expect(mockGit).toHaveBeenCalledWith(
      ["worktree", "remove", "--force", "/tmp/test-wt"],
      expect.any(String),
    );
  });
});

describe("session cleanup", () => {
  it("kills sessions with merged PRs", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "app-1"),
      "branch=feat/fix\nstatus=merged\npr=https://github.com/org/repo/pull/42\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "kill-session") return "";
      return null;
    });
    mockGh.mockResolvedValue("MERGED");
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "cleanup"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Killing app-1: PR #42 merged");
    expect(output).toContain("Cleanup complete. 1 sessions cleaned");
  });

  it("does not kill sessions with open PRs", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "app-1"),
      "branch=feat/fix\nstatus=pr_open\npr=https://github.com/org/repo/pull/42\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      return null;
    });
    mockGh.mockResolvedValue("OPEN");

    await program.parseAsync(["node", "test", "session", "cleanup"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No sessions to clean up");
  });

  it("dry run shows what would be cleaned without doing it", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "app-1"),
      "branch=feat/fix\npr=https://github.com/org/repo/pull/42\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      return null;
    });
    mockGh.mockResolvedValue("MERGED");

    await program.parseAsync(["node", "test", "session", "cleanup", "--dry-run"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Would kill app-1");

    // Metadata should still exist
    expect(existsSync(join(sessionDir, "app-1"))).toBe(true);
  });

  it("continues cleaning remaining sessions when one kill fails", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "app-1"),
      "branch=feat/a\npr=https://github.com/org/repo/pull/10\n",
    );
    writeFileSync(
      join(sessionDir, "app-2"),
      "branch=feat/b\npr=https://github.com/org/repo/pull/20\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1\napp-2";
      // First kill-session call throws, second succeeds
      if (args[0] === "kill-session" && args[2] === "app-1") {
        throw new Error("tmux error");
      }
      return "";
    });
    mockGh.mockResolvedValue("MERGED");
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "cleanup"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const errOutput = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join("\n");
    // First session fails but loop continues to second
    expect(errOutput).toContain("Failed to kill app-1");
    expect(output).toContain("Killing app-2");
  });

  it("skips sessions without metadata", async () => {
    // No metadata files exist
    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      return null;
    });

    await program.parseAsync(["node", "test", "session", "cleanup"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No sessions to clean up");
  });
});
