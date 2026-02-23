import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  type Session,
  type SessionManager,
  type ActivityState,
  getSessionsDir,
} from "@composio/ao-core";

const {
  mockTmux,
  mockGit,
  mockConfigRef,
  mockIntrospect,
  mockGetActivityState,
  mockDetectPR,
  mockGetCISummary,
  mockGetReviewDecision,
  mockGetPendingComments,
  mockSessionManager,
  sessionsDirRef,
} = vi.hoisted(() => ({
  mockTmux: vi.fn(),
  mockGit: vi.fn(),
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockIntrospect: vi.fn(),
  mockGetActivityState: vi.fn(),
  mockDetectPR: vi.fn(),
  mockGetCISummary: vi.fn(),
  mockGetReviewDecision: vi.fn(),
  mockGetPendingComments: vi.fn(),
  mockSessionManager: {
    list: vi.fn(),
    kill: vi.fn(),
    cleanup: vi.fn(),
    get: vi.fn(),
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    send: vi.fn(),
  },
  sessionsDirRef: { current: "" },
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

vi.mock("@composio/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@composio/ao-core")>();
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
  };
});

vi.mock("../../src/lib/plugins.js", () => ({
  getAgent: () => ({
    name: "claude-code",
    processName: "claude",
    detectActivity: () => "idle",
    getSessionInfo: mockIntrospect,
    getActivityState: mockGetActivityState,
  }),
  getAgentByName: () => ({
    name: "claude-code",
    processName: "claude",
    detectActivity: () => "idle",
    getSessionInfo: mockIntrospect,
    getActivityState: mockGetActivityState,
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

/** Parse a key=value metadata file into a Record<string, string>. */
function parseMetadata(content: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return meta;
}

/** Build Session objects from metadata files in sessionsDir. */
function buildSessionsFromDir(
  dir: string,
  projectId: string,
  activityOverride?: ActivityState | null,
): Session[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => !f.startsWith(".") && f !== "archive");
  return files.map((name) => {
    const content = readFileSync(join(dir, name), "utf-8");
    const meta = parseMetadata(content);
    return {
      id: name,
      projectId,
      status: (meta["status"] as Session["status"]) || "spawning",
      activity: activityOverride !== undefined ? activityOverride : null,
      branch: meta["branch"] || null,
      issueId: meta["issue"] || null,
      pr: null,
      workspacePath: meta["worktree"] || null,
      runtimeHandle: { id: name, runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: meta,
    } satisfies Session;
  });
}

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async (): Promise<SessionManager> => mockSessionManager as SessionManager,
}));

let tmpDir: string;
let sessionsDir: string;

import { Command } from "commander";
import { registerStatus } from "../../src/commands/status.js";

let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-status-test-"));

  const configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}");

  mockConfigRef.current = {
    configPath,
    port: 3000,
    readyThresholdMs: 300_000,
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
        scm: { plugin: "github" },
      },
    },
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  } as Record<string, unknown>;

  // Calculate and create sessions directory for hash-based architecture
  sessionsDir = getSessionsDir(configPath, join(tmpDir, "main-repo"));
  mkdirSync(sessionsDir, { recursive: true });
  sessionsDirRef.current = sessionsDir;

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
  mockGetActivityState.mockReset();
  mockGetActivityState.mockResolvedValue("active");
  mockDetectPR.mockReset();
  mockDetectPR.mockResolvedValue(null);
  mockGetCISummary.mockReset();
  mockGetCISummary.mockResolvedValue("none");
  mockGetReviewDecision.mockReset();
  mockGetReviewDecision.mockResolvedValue("none");
  mockGetPendingComments.mockReset();
  mockGetPendingComments.mockResolvedValue([]);
  mockSessionManager.list.mockReset();
  mockSessionManager.kill.mockReset();
  mockSessionManager.cleanup.mockReset();
  mockSessionManager.get.mockReset();
  mockSessionManager.spawn.mockReset();
  mockSessionManager.send.mockReset();

  // Default: list reads from sessionsDir
  mockSessionManager.list.mockImplementation(async () => {
    return buildSessionsFromDir(sessionsDirRef.current, "my-app");
  });
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
    writeFileSync(
      join(sessionsDir, "app-1"),
      "worktree=/tmp/wt/app-1\nbranch=feat/INT-100\nstatus=working\nissue=INT-100\n",
    );
    writeFileSync(
      join(sessionsDir, "app-2"),
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
    // other-session should not appear (not in metadata)
    expect(output).not.toContain("other-session");
  });

  it("counts total sessions correctly", async () => {
    writeFileSync(join(sessionsDir, "app-1"), "branch=main\nstatus=idle\n");

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
    writeFileSync(join(sessionsDir, "app-1"), "branch=a\nstatus=idle\n");
    writeFileSync(join(sessionsDir, "app-2"), "branch=b\nstatus=idle\n");

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
    writeFileSync(
      join(sessionsDir, "app-1"),
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
    writeFileSync(join(sessionsDir, "app-1"), "branch=main\nstatus=idle\n");

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
    writeFileSync(
      join(sessionsDir, "app-1"),
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
    writeFileSync(
      join(sessionsDir, "app-1"),
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
    writeFileSync(
      join(sessionsDir, "app-1"),
      "worktree=/tmp/wt\nbranch=feat/err\nstatus=working\n",
    );

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
    writeFileSync(
      join(sessionsDir, "app-1"),
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
    writeFileSync(
      join(sessionsDir, "app-1"),
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
    writeFileSync(
      join(sessionsDir, "app-1"),
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

  it("uses session.activity from session manager for activity detection", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "worktree=/tmp/wt\nbranch=feat/act\nstatus=working\n",
    );

    // Override list to return sessions with activity set to "ready"
    mockSessionManager.list.mockImplementation(async () => {
      return buildSessionsFromDir(sessionsDirRef.current, "my-app", "ready");
    });

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return String(Math.floor(Date.now() / 1000));
      return null;
    });
    mockGit.mockResolvedValue("feat/act");

    await program.parseAsync(["node", "test", "status", "--json"]);

    const jsonCalls = consoleSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(jsonCalls);
    expect(parsed[0].activity).toBe("ready");
  });

  it("shows null activity when session has no activity set", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "worktree=/tmp/wt\nbranch=feat/thr\nstatus=working\n",
    );

    // Default list mock returns activity: null
    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return String(Math.floor(Date.now() / 1000));
      return null;
    });
    mockGit.mockResolvedValue("feat/thr");

    await program.parseAsync(["node", "test", "status", "--json"]);

    const jsonCalls = consoleSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(jsonCalls);
    expect(parsed[0].activity).toBeNull();
  });

  it("shows exited activity from session manager", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "worktree=/tmp/wt\nbranch=feat/dead\nstatus=working\n",
    );

    mockSessionManager.list.mockImplementation(async () => {
      return buildSessionsFromDir(sessionsDirRef.current, "my-app", "exited");
    });

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return null;
      return null;
    });
    mockGit.mockResolvedValue("feat/dead");

    await program.parseAsync(["node", "test", "status", "--json"]);

    const jsonCalls = consoleSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(jsonCalls);
    expect(parsed[0].activity).toBe("exited");
  });

  it("handles session with no branch (detectPR still called)", async () => {
    // Session with NO branch and NO worktree — exercises the code path
    // where the old status.ts had `if (branch)` guard before SCM detectPR.
    // After refactoring to shared helper, detectPR is called unconditionally.
    writeFileSync(join(sessionsDir, "app-1"), "status=working\n");

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return null;
      return null;
    });
    mockGit.mockResolvedValue(null);
    mockDetectPR.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "status", "--json"]);

    const jsonCalls = consoleSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(jsonCalls);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].branch).toBeNull();
    expect(parsed[0].prNumber).toBeNull();
    expect(parsed[0].ciStatus).toBeNull();
    // detectPR should still be called (shared helper doesn't gate on branch)
    expect(mockDetectPR).toHaveBeenCalled();
  });

  it("uses prUrl from SCM, not stale metadata URL", async () => {
    // Metadata has one PR URL, SCM detects a different one.
    // The returned `pr` field should match the SCM result.
    writeFileSync(
      join(sessionsDir, "app-1"),
      "worktree=/tmp/wt\nbranch=feat/moved\nstatus=working\npr=https://github.com/org/repo/pull/10\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return String(Math.floor(Date.now() / 1000));
      return null;
    });
    mockGit.mockResolvedValue("feat/moved");

    // SCM detects a different PR than what's in metadata
    mockDetectPR.mockResolvedValue({
      number: 42,
      url: "https://github.com/org/repo/pull/42",
      title: "New PR",
      owner: "org",
      repo: "repo",
      branch: "feat/moved",
      baseBranch: "main",
      isDraft: false,
    });
    mockGetCISummary.mockResolvedValue("passing");
    mockGetReviewDecision.mockResolvedValue("none");
    mockGetPendingComments.mockResolvedValue([]);

    await program.parseAsync(["node", "test", "status", "--json"]);

    const jsonCalls = consoleSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(jsonCalls);
    expect(parsed[0].prNumber).toBe(42);
    // pr URL should match SCM (pull/42), NOT stale metadata (pull/10)
    expect(parsed[0].pr).toBe("https://github.com/org/repo/pull/42");
  });
});
