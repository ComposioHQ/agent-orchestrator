import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const {
  mockTmux,
  mockGit,
  mockConfigRef,
  mockIntrospect,
  mockDetectPR,
  mockGetCISummary,
  mockGetReviewDecision,
  mockGetPendingComments,
} = vi.hoisted(() => ({
  mockTmux: vi.fn(),
  mockGit: vi.fn(),
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockIntrospect: vi.fn(),
  mockDetectPR: vi.fn(),
  mockGetCISummary: vi.fn(),
  mockGetReviewDecision: vi.fn(),
  mockGetPendingComments: vi.fn(),
}));

vi.mock("../../src/lib/shell.js", () => ({
  tmux: mockTmux,
  exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
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

vi.mock("@composio/ao-core", () => ({
  loadConfig: () => mockConfigRef.current,
}));

vi.mock("../../src/lib/plugins.js", () => ({
  getAgent: () => ({
    name: "claude-code",
    processName: "claude",
    detectActivity: () => "idle",
    getSessionInfo: mockIntrospect,
  }),
  getAgentByName: () => ({
    name: "claude-code",
    processName: "claude",
    detectActivity: () => "idle",
    getSessionInfo: mockIntrospect,
  }),
  getSCM: () => ({
    name: "github",
    detectPR: mockDetectPR,
    getCISummary: mockGetCISummary,
    getReviewDecision: mockGetReviewDecision,
    getPendingComments: mockGetPendingComments,
    getAutomatedComments: vi.fn().mockResolvedValue([]),
    getCIChecks: vi.fn().mockResolvedValue([]),
    getReviews: vi.fn().mockResolvedValue([]),
    getMergeability: vi.fn().mockResolvedValue({
      mergeable: true,
      ciPassing: true,
      approved: false,
      noConflicts: true,
      blockers: [],
    }),
    getPRState: vi.fn().mockResolvedValue("open"),
    mergePR: vi.fn(),
    closePR: vi.fn(),
  }),
}));

let tmpDir: string;

import { Command } from "commander";
import { registerStatus } from "../../src/commands/status.js";

let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-status-test-"));
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
        path: "/home/user/my-app",
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "github" },
      },
    },
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  } as Record<string, unknown>;

  program = new Command();
  program.exitOverride();
  registerStatus(program);
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
  mockTmux.mockReset();
  mockGit.mockReset();
  mockIntrospect.mockReset();
  mockIntrospect.mockResolvedValue(null);
  mockDetectPR.mockReset();
  mockDetectPR.mockResolvedValue(null);
  mockGetCISummary.mockReset();
  mockGetCISummary.mockResolvedValue("none");
  mockGetReviewDecision.mockReset();
  mockGetReviewDecision.mockResolvedValue("none");
  mockGetPendingComments.mockReset();
  mockGetPendingComments.mockResolvedValue([]);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("status command", () => {
  it("shows banner and project header", async () => {
    mockTmux.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "status"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("AGENT ORCHESTRATOR STATUS");
    expect(output).toContain("My App");
  });

  it("shows no active sessions when tmux returns nothing", async () => {
    mockTmux.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "status"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("no active sessions");
  });

  it("displays sessions from tmux with metadata", async () => {
    // Create metadata files
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "app-1"),
      "worktree=/tmp/wt/app-1\nbranch=feat/INT-100\nstatus=working\nissue=INT-100\n",
    );
    writeFileSync(
      join(sessionDir, "app-2"),
      "worktree=/tmp/wt/app-2\nbranch=feat/INT-200\nstatus=pr_open\npr=https://github.com/org/repo/pull/42\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") {
        return "app-1\napp-2\nother-session";
      }
      if (args[0] === "display-message") {
        return String(Math.floor(Date.now() / 1000) - 120); // 2 min ago
      }
      return null;
    });

    mockGit.mockResolvedValue("feat/INT-100"); // live branch

    await program.parseAsync(["node", "test", "status"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("app-1");
    expect(output).toContain("app-2");
    expect(output).toContain("INT-100");
    // other-session should not appear (doesn't match prefix)
    expect(output).not.toContain("other-session");
  });

  it("counts total sessions correctly", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "app-1"), "branch=main\nstatus=idle\n");

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return null;
      return null;
    });
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "status"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("1 active session");
  });

  it("shows plural for multiple sessions", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "app-1"), "branch=a\nstatus=idle\n");
    writeFileSync(join(sessionDir, "app-2"), "branch=b\nstatus=idle\n");

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1\napp-2";
      if (args[0] === "display-message") return null;
      return null;
    });
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "status"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("2 active sessions");
  });

  it("prefers live branch over metadata branch", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "app-1"),
      "worktree=/tmp/wt\nbranch=old-branch\nstatus=working\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return null;
      return null;
    });
    mockGit.mockResolvedValue("live-branch");

    await program.parseAsync(["node", "test", "status"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("live-branch");
  });

  it("shows table header with column names", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "app-1"), "branch=main\nstatus=idle\n");

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return null;
      return null;
    });
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "status"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Session");
    expect(output).toContain("Branch");
    expect(output).toContain("PR");
    expect(output).toContain("CI");
    expect(output).toContain("Activity");
  });

  it("shows PR number, CI status, review decision, and threads", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "app-1"),
      "worktree=/tmp/wt\nbranch=feat/test\nstatus=working\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return String(Math.floor(Date.now() / 1000) - 60);
      return null;
    });
    mockGit.mockResolvedValue("feat/test");

    mockDetectPR.mockResolvedValue({
      number: 42,
      url: "https://github.com/org/repo/pull/42",
      title: "Test PR",
      owner: "org",
      repo: "repo",
      branch: "feat/test",
      baseBranch: "main",
      isDraft: false,
    });
    mockGetCISummary.mockResolvedValue("passing");
    mockGetReviewDecision.mockResolvedValue("approved");
    mockGetPendingComments.mockResolvedValue([
      {
        id: "1",
        author: "reviewer",
        body: "fix this",
        isResolved: false,
        createdAt: new Date(),
        url: "",
      },
      {
        id: "2",
        author: "reviewer2",
        body: "fix that",
        isResolved: false,
        createdAt: new Date(),
        url: "",
      },
    ]);

    await program.parseAsync(["node", "test", "status"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("#42");
    expect(output).toContain("pass");
    expect(output).toContain("ok"); // approved
    expect(output).toContain("2"); // pending threads
  });

  it("shows failing CI and changes_requested review", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "app-1"),
      "worktree=/tmp/wt\nbranch=feat/broken\nstatus=working\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return null;
      return null;
    });
    mockGit.mockResolvedValue("feat/broken");

    mockDetectPR.mockResolvedValue({
      number: 7,
      url: "https://github.com/org/repo/pull/7",
      title: "Broken PR",
      owner: "org",
      repo: "repo",
      branch: "feat/broken",
      baseBranch: "main",
      isDraft: false,
    });
    mockGetCISummary.mockResolvedValue("failing");
    mockGetReviewDecision.mockResolvedValue("changes_requested");
    mockGetPendingComments.mockResolvedValue([]);

    await program.parseAsync(["node", "test", "status"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("#7");
    expect(output).toContain("fail");
    expect(output).toContain("chg!"); // changes_requested
  });

  it("handles SCM errors gracefully", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "app-1"), "worktree=/tmp/wt\nbranch=feat/err\nstatus=working\n");

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return null;
      return null;
    });
    mockGit.mockResolvedValue("feat/err");

    mockDetectPR.mockRejectedValue(new Error("gh failed"));

    await program.parseAsync(["node", "test", "status"]);

    // Should still show the session without crashing
    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("app-1");
    expect(output).toContain("feat/err");
  });

  it("outputs JSON with enriched fields", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "app-1"),
      "worktree=/tmp/wt\nbranch=feat/json\nstatus=working\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return String(Math.floor(Date.now() / 1000));
      return null;
    });
    mockGit.mockResolvedValue("feat/json");

    mockDetectPR.mockResolvedValue({
      number: 10,
      url: "https://github.com/org/repo/pull/10",
      title: "JSON PR",
      owner: "org",
      repo: "repo",
      branch: "feat/json",
      baseBranch: "main",
      isDraft: false,
    });
    mockGetCISummary.mockResolvedValue("passing");
    mockGetReviewDecision.mockResolvedValue("pending");
    mockGetPendingComments.mockResolvedValue([]);

    await program.parseAsync(["node", "test", "status", "--json"]);

    const jsonCalls = consoleSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(jsonCalls);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].prNumber).toBe(10);
    expect(parsed[0].ciStatus).toBe("passing");
    expect(parsed[0].reviewDecision).toBe("pending");
    expect(parsed[0].pendingThreads).toBe(0);
  });

  it("falls back to PR number from metadata URL when SCM fails", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "app-1"),
      "worktree=/tmp/wt\nbranch=feat/pr-meta\nstatus=working\npr=https://github.com/org/repo/pull/99\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return null;
      return null;
    });
    mockGit.mockResolvedValue("feat/pr-meta");

    // SCM detectPR fails
    mockDetectPR.mockRejectedValue(new Error("gh failed"));

    await program.parseAsync(["node", "test", "status"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("#99");
  });

  it("shows null pendingThreads when getPendingComments fails", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "app-1"),
      "worktree=/tmp/wt\nbranch=feat/thr-err\nstatus=working\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return String(Math.floor(Date.now() / 1000));
      return null;
    });
    mockGit.mockResolvedValue("feat/thr-err");

    mockDetectPR.mockResolvedValue({
      number: 5,
      url: "https://github.com/org/repo/pull/5",
      title: "Thread err PR",
      owner: "org",
      repo: "repo",
      branch: "feat/thr-err",
      baseBranch: "main",
      isDraft: false,
    });
    mockGetCISummary.mockResolvedValue("passing");
    mockGetReviewDecision.mockResolvedValue("none");
    // getPendingComments rejects — should result in null, not 0
    mockGetPendingComments.mockRejectedValue(new Error("graphql failed"));

    await program.parseAsync(["node", "test", "status", "--json"]);

    const jsonCalls = consoleSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(jsonCalls);
    expect(parsed[0].pendingThreads).toBeNull();
  });

  it("falls back to metadata status for activity when introspection unavailable", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "app-1"),
      "worktree=/tmp/wt\nbranch=feat/meta-act\nstatus=working\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return String(Math.floor(Date.now() / 1000));
      return null;
    });
    mockGit.mockResolvedValue("feat/meta-act");

    // Introspection returns null (no session info)
    mockIntrospect.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "status", "--json"]);

    const jsonCalls = consoleSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(jsonCalls);
    // status=working should fall back to activity=active
    expect(parsed[0].activity).toBe("active");
  });

  it("treats assistant lastMessageType as idle, not active", async () => {
    const sessionDir = join(tmpDir, "my-app-sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "app-1"),
      "worktree=/tmp/wt\nbranch=feat/asst\nstatus=working\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return String(Math.floor(Date.now() / 1000));
      return null;
    });
    mockGit.mockResolvedValue("feat/asst");

    mockIntrospect.mockResolvedValue({
      summary: "Working on feature",
      agentSessionId: "abc",
      lastMessageType: "assistant",
    });

    await program.parseAsync(["node", "test", "status", "--json"]);

    const jsonCalls = consoleSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(jsonCalls);
    expect(parsed[0].activity).toBe("idle");
  });
});
