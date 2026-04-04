import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  type Session,
  type SessionManager,
  type ActivityState,
} from "@composio/ao-core";

const {
  mockTmux,
  mockGit,
  mockConfigRef,
  mockIntrospect,
  mockGetActivityState,
  mockDetectPR,
  mockGetCISummary,
  mockIssueUrl,
  mockGetReviewDecision,
  mockGetPendingComments,
  mockSessionManager,
  mockGetPluginRegistry,
  sessionsDirRef,
} = vi.hoisted(() => ({
  mockTmux: vi.fn(),
  mockGit: vi.fn(),
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockIntrospect: vi.fn(),
  mockGetActivityState: vi.fn(),
  mockDetectPR: vi.fn(),
  mockGetCISummary: vi.fn(),
  mockIssueUrl: vi.fn(),
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
    claimPR: vi.fn(),
  },
  mockGetPluginRegistry: vi.fn(),
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
  getAgentByNameFromRegistry: () => ({
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
  getSCMFromRegistry: () => ({
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

function makeSession(overrides: Partial<Session> & { id: string; projectId: string }): Session {
  return {
    id: overrides.id,
    projectId: overrides.projectId,
    status: "working",
    activity: null,
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: { id: overrides.id, runtimeName: "tmux", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  } satisfies Session;
}

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async (): Promise<SessionManager> => mockSessionManager as SessionManager,
  getPluginRegistry: (...args: unknown[]) => mockGetPluginRegistry(...args),
}));

let tmpDir: string;
let sessionsDir: string;

import { Command } from "commander";
import { registerStatus } from "../../src/commands/status.js";

let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;
let setIntervalSpy: ReturnType<typeof vi.spyOn> | undefined;
let clearIntervalSpy: ReturnType<typeof vi.spyOn> | undefined;
let processOnceSpy: ReturnType<typeof vi.spyOn> | undefined;

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

  // Keep test metadata under the temp fixture directory instead of ~/.agent-orchestrator.
  sessionsDir = join(tmpDir, "sessions");
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
  mockIssueUrl.mockReset();
  mockIssueUrl.mockImplementation((issueId: string) => `https://tracker.example/issues/${issueId}`);
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
  mockGetPluginRegistry.mockReset();
  // Default registry: no tracker
  mockGetPluginRegistry.mockResolvedValue({ get: vi.fn().mockReturnValue(null), list: vi.fn(), register: vi.fn() });

  // Default: list reads from sessionsDir
  mockSessionManager.list.mockImplementation(async () => {
    return buildSessionsFromDir(sessionsDirRef.current, "my-app");
  });
});

afterEach(() => {
  setIntervalSpy?.mockRestore();
  setIntervalSpy = undefined;
  clearIntervalSpy?.mockRestore();
  clearIntervalSpy = undefined;
  processOnceSpy?.mockRestore();
  processOnceSpy = undefined;
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
    expect(output).toContain("Issue");
    expect(output).toContain("Branch");
    expect(output).toContain("PR");
    expect(output).toContain("CI");
    expect(output).toContain("Activity");
  });

  it("shows the issue identifier for worker sessions in the table", async () => {
    mockConfigRef.current = {
      ...(mockConfigRef.current as Record<string, unknown>),
      projects: {
        "my-app": {
          name: "My App",
          repo: "org/my-app",
          path: join(tmpDir, "main-repo"),
          defaultBranch: "main",
          sessionPrefix: "app",
          tracker: { plugin: "linear" },
          scm: { plugin: "github" },
        },
      },
    } as Record<string, unknown>;

    writeFileSync(
      join(sessionsDir, "app-1"),
      "worktree=/tmp/wt\nbranch=feat/status\nstatus=working\nissue=ENG-1633\n",
    );

    mockGetPluginRegistry.mockResolvedValue({
      get: vi.fn((slot: string) => {
        if (slot === "tracker") {
          return { issueUrl: mockIssueUrl };
        }
        return null;
      }),
      list: vi.fn(),
      register: vi.fn(),
    });
    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return null;
      return null;
    });
    mockGit.mockResolvedValue("feat/status");

    await program.parseAsync(["node", "test", "status"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("ENG-1633");
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

  it("includes issueUrl in JSON output when a tracker is configured", async () => {
    mockConfigRef.current = {
      ...(mockConfigRef.current as Record<string, unknown>),
      projects: {
        "my-app": {
          name: "My App",
          repo: "org/my-app",
          path: join(tmpDir, "main-repo"),
          defaultBranch: "main",
          sessionPrefix: "app",
          tracker: { plugin: "linear" },
          scm: { plugin: "github" },
        },
      },
    } as Record<string, unknown>;

    writeFileSync(
      join(sessionsDir, "app-1"),
      "worktree=/tmp/wt\nbranch=feat/json\nstatus=working\nissue=ENG-1633\n",
    );

    mockGetPluginRegistry.mockResolvedValue({
      get: vi.fn((slot: string) => {
        if (slot === "tracker") {
          return { issueUrl: mockIssueUrl };
        }
        return null;
      }),
      list: vi.fn(),
      register: vi.fn(),
    });
    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return String(Math.floor(Date.now() / 1000));
      return null;
    });
    mockGit.mockResolvedValue("feat/json");

    await program.parseAsync(["node", "test", "status", "--json"]);

    const jsonCalls = consoleSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(jsonCalls);
    expect(parsed[0].issue).toBe("ENG-1633");
    expect(parsed[0].issueUrl).toBe("https://tracker.example/issues/ENG-1633");
  });

  it("rejects --watch with --json", async () => {
    await expect(program.parseAsync(["node", "test", "status", "--watch", "--json"])).rejects.toThrow(
      "process.exit(1)",
    );

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c[0])
      .join("\n");
    expect(errors).toContain("--watch cannot be used with --json");
  });

  it("rejects non-positive watch intervals", async () => {
    await expect(program.parseAsync(["node", "test", "status", "--watch", "--interval", "0"])).rejects.toThrow(
      "process.exit(1)",
    );

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c[0])
      .join("\n");
    expect(errors).toContain("--interval must be a positive integer");
  });

  it("ignores --interval entirely when --watch is not set", async () => {
    mockTmux.mockResolvedValue(null);
    mockSessionManager.list.mockResolvedValue([]);

    // Invalid value (0) should NOT cause an error without --watch
    await expect(
      program.parseAsync(["node", "test", "status", "--interval", "0"]),
    ).resolves.not.toThrow();

    // Valid value should also be silently ignored without --watch
    await expect(
      program.parseAsync(["node", "test", "status", "--interval", "10"]),
    ).resolves.not.toThrow();
  });

  it("schedules watch refreshes with the requested interval", async () => {
    mockTmux.mockResolvedValue(null);
    setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(() => 1 as never);

    await program.parseAsync(["node", "test", "status", "--watch", "--interval", "3"]);

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 3000);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Refreshing every 3s. Press Ctrl+C to exit.");
  });

  it("cleans up the watch timer on shutdown signals", async () => {
    mockTmux.mockResolvedValue(null);

    const watchTimer = { id: "watch-timer" } as unknown as ReturnType<typeof setInterval>;
    setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(() => watchTimer);
    clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);

    const signalHandlers = new Map<string, () => void>();
    processOnceSpy = vi.spyOn(process, "once").mockImplementation((event, listener) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        signalHandlers.set(event, listener as () => void);
      }
      return process;
    });

    await program.parseAsync(["node", "test", "status", "--watch"]);

    expect(signalHandlers.has("SIGINT")).toBe(true);
    expect(signalHandlers.has("SIGTERM")).toBe(true);

    expect(() => signalHandlers.get("SIGINT")?.()).toThrow("process.exit(0)");
    expect(clearIntervalSpy).toHaveBeenCalledWith(watchTimer);
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

  it("shows null activity when session activity is null", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "worktree=/tmp/wt\nbranch=feat/err\nstatus=working\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return String(Math.floor(Date.now() / 1000));
      return null;
    });
    mockGit.mockResolvedValue("feat/err");

    // Session has activity: null (default from buildSessionsFromDir)
    await program.parseAsync(["node", "test", "status", "--json"]);

    const jsonCalls = consoleSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(jsonCalls);
    expect(parsed[0].activity).toBeNull();
  });

  it("shows null activity when session activity is explicitly null", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "worktree=/tmp/wt\nbranch=feat/null\nstatus=working\n",
    );

    mockSessionManager.list.mockImplementation(async () => {
      return buildSessionsFromDir(sessionsDirRef.current, "my-app", null);
    });

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") return String(Math.floor(Date.now() / 1000));
      return null;
    });
    mockGit.mockResolvedValue("feat/null");

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

  it("suppresses orchestrator PR ownership in status output", async () => {
    writeFileSync(
      join(sessionsDir, "app-orchestrator"),
      [
        "worktree=/tmp/wt",
        "branch=main",
        "status=working",
        "role=orchestrator",
        "pr=https://github.com/org/repo/pull/77",
      ].join("\n"),
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-orchestrator";
      if (args[0] === "display-message") return String(Math.floor(Date.now() / 1000));
      return null;
    });
    mockGit.mockResolvedValue("main");
    mockDetectPR.mockResolvedValue({
      number: 77,
      url: "https://github.com/org/repo/pull/77",
      title: "Orchestrator should not own this",
      owner: "org",
      repo: "repo",
      branch: "main",
      baseBranch: "main",
      isDraft: false,
    });

    await program.parseAsync(["node", "test", "status", "--json"]);

    const parsed = JSON.parse(consoleSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed[0].name).toBe("app-orchestrator");
    expect(parsed[0].pr).toBeNull();
    expect(parsed[0].prNumber).toBeNull();
    expect(mockDetectPR).not.toHaveBeenCalled();
  });

  it("shows one orchestrator per project without counting them as worker sessions", async () => {
    mockConfigRef.current = {
      ...(mockConfigRef.current as Record<string, unknown>),
      projects: {
        "my-app": {
          name: "My App",
          repo: "org/my-app",
          path: join(tmpDir, "main-repo"),
          defaultBranch: "main",
          sessionPrefix: "app",
          scm: { plugin: "github" },
        },
        docs: {
          name: "Docs",
          repo: "org/docs",
          path: join(tmpDir, "docs-repo"),
          defaultBranch: "main",
          sessionPrefix: "docs",
          scm: { plugin: "github" },
        },
      },
    } as Record<string, unknown>;

    mockSessionManager.list.mockResolvedValue([
      makeSession({
        id: "app-orchestrator",
        projectId: "my-app",
        metadata: { role: "orchestrator", summary: "Manage app agents" },
      }),
      makeSession({ id: "app-1", projectId: "my-app", branch: "feat/app", activity: "active" }),
      makeSession({
        id: "docs-orchestrator",
        projectId: "docs",
        metadata: { role: "orchestrator" },
      }),
    ]);
    mockGit.mockResolvedValue(null);
    mockIntrospect.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "status"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Orchestrator:");
    expect(output).toContain("app-orchestrator");
    expect(output).toContain("docs-orchestrator");
    expect(output).toContain("1 active session across 2 projects · 2 orchestrators");
  });

  it("includes orchestrators in JSON output with explicit roles", async () => {
    mockSessionManager.list.mockResolvedValue([
      makeSession({
        id: "app-orchestrator",
        projectId: "my-app",
        metadata: { role: "orchestrator" },
      }),
      makeSession({
        id: "app-1",
        projectId: "my-app",
        branch: "feat/json-worker",
        activity: "ready",
      }),
    ]);
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "status", "--json"]);

    const jsonCalls = consoleSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(jsonCalls);
    expect(parsed).toHaveLength(2);
    expect(
      parsed.find((entry: { name: string }) => entry.name === "app-orchestrator"),
    ).toMatchObject({
      role: "orchestrator",
      project: "my-app",
    });
    expect(parsed.find((entry: { name: string }) => entry.name === "app-1")).toMatchObject({
      role: "worker",
      project: "my-app",
    });
  });

  // ── lines 262-266: loadConfig() throws → fallback to tmux discovery ───────
  it("falls back to tmux session discovery when loadConfig throws", async () => {
    // The vi.mock for @composio/ao-core uses `() => mockConfigRef.current`.
    // Setting current to a throwing getter makes loadConfig throw.
    // Simpler: use a Proxy-based trick — but easiest is a getter that throws.
    const originalCurrent = mockConfigRef.current;
    Object.defineProperty(mockConfigRef, "current", {
      get() {
        throw new Error("no config file");
      },
      configurable: true,
    });

    // No tmux sessions — fallback should print the banner with "No config found"
    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return null;
      return null;
    });
    mockIntrospect.mockResolvedValue(null);

    try {
      await program.parseAsync(["node", "test", "status"]);
    } finally {
      // Restore mockConfigRef.current to a plain data property
      Object.defineProperty(mockConfigRef, "current", {
        value: originalCurrent,
        writable: true,
        configurable: true,
      });
    }

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("No config found");
    expect(output).toContain("Falling back to session discovery");
  });

  // ── lines 269-271: unknown --project flag ───────────────────────────────
  it("exits with error when --project refers to an unknown project", async () => {
    mockTmux.mockResolvedValue(null);
    mockSessionManager.list.mockResolvedValue([]);

    await expect(
      program.parseAsync(["node", "test", "status", "--project", "no-such-project"]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c[0])
      .join("\n");
    expect(errors).toContain("Unknown project: no-such-project");
  });

  // ── lines 388, 390-396, 402-405: tracker unverified-issues warning ────────
  it("shows unverified issues warning when tracker returns merged-unverified issues", async () => {
    const mockListIssues = vi.fn().mockResolvedValue([{ id: "ISS-1" }, { id: "ISS-2" }]);
    const mockTracker = { listIssues: mockListIssues };

    mockConfigRef.current = {
      ...(mockConfigRef.current as Record<string, unknown>),
      projects: {
        "my-app": {
          name: "My App",
          repo: "org/my-app",
          path: join(tmpDir, "main-repo"),
          defaultBranch: "main",
          sessionPrefix: "app",
          scm: { plugin: "github" },
          tracker: { plugin: "linear" },
        },
      },
    } as Record<string, unknown>;

    // Use the hoisted mockGetPluginRegistry fn to surface our tracker
    mockGetPluginRegistry.mockResolvedValueOnce({
      get: vi.fn().mockReturnValue(mockTracker),
      list: vi.fn(),
      register: vi.fn(),
    });

    mockSessionManager.list.mockResolvedValue([]);
    mockTmux.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "status"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("awaiting verification");
    expect(mockListIssues).toHaveBeenCalledWith(
      { state: "open", labels: ["merged-unverified"], limit: 20 },
      expect.objectContaining({ tracker: { plugin: "linear" } }),
    );
  });

  // ── line 398: tracker listIssues() rejects → swallowed silently ───────────
  it("handles tracker listIssues failure gracefully without crashing", async () => {
    const mockListIssues = vi.fn().mockRejectedValue(new Error("tracker down"));
    const mockTracker = { listIssues: mockListIssues };

    mockConfigRef.current = {
      ...(mockConfigRef.current as Record<string, unknown>),
      projects: {
        "my-app": {
          name: "My App",
          repo: "org/my-app",
          path: join(tmpDir, "main-repo"),
          defaultBranch: "main",
          sessionPrefix: "app",
          scm: { plugin: "github" },
          tracker: { plugin: "linear" },
        },
      },
    } as Record<string, unknown>;

    mockGetPluginRegistry.mockResolvedValueOnce({
      get: vi.fn().mockReturnValue(mockTracker),
      list: vi.fn(),
      register: vi.fn(),
    });

    mockSessionManager.list.mockResolvedValue([]);
    mockTmux.mockResolvedValue(null);

    // Must not throw
    await expect(program.parseAsync(["node", "test", "status"])).resolves.not.toThrow();
  });

  // ── lines 65-69 (isTTY branch) + 255-256 (maybeClearScreen on refresh) ───
  it("writes clear-screen escape when stdout is a TTY during watch refresh", async () => {
    mockTmux.mockResolvedValue(null);
    mockSessionManager.list.mockResolvedValue([]);

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    let capturedCallback: (() => void) | undefined;
    setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((fn) => {
      capturedCallback = fn as () => void;
      return 77 as never;
    });
    clearIntervalSpy = vi
      .spyOn(globalThis, "clearInterval")
      .mockImplementation(() => undefined);
    processOnceSpy = vi.spyOn(process, "once").mockImplementation((_e, _l) => process);

    await program.parseAsync(["node", "test", "status", "--watch", "--interval", "5"]);

    expect(capturedCallback).toBeDefined();
    // Fire interval callback — this calls renderStatus(true) which calls maybeClearScreen()
    capturedCallback!();
    // Allow promises to settle
    await new Promise((r) => setTimeout(r, 20));

    expect(writeSpy).toHaveBeenCalledWith("\x1Bc");

    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
    writeSpy.mockRestore();
  });

  // ── lines 424-425: watch guard skips render when already in progress ──────
  it("skips a watch refresh when the previous render is still in progress", async () => {
    let renderCount = 0;
    let unblockSlowRender!: () => void;
    const slowRenderFinished = new Promise<void>((res) => {
      unblockSlowRender = res;
    });

    mockSessionManager.list.mockImplementation(async () => {
      renderCount++;
      if (renderCount === 2) {
        // First watch-refresh (second overall list call) — block deliberately
        await slowRenderFinished;
      }
      return [];
    });

    mockTmux.mockResolvedValue(null);

    let capturedCallback: (() => void) | undefined;
    setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((fn) => {
      capturedCallback = fn as () => void;
      return 55 as never;
    });
    clearIntervalSpy = vi
      .spyOn(globalThis, "clearInterval")
      .mockImplementation(() => undefined);
    processOnceSpy = vi.spyOn(process, "once").mockImplementation((_e, _l) => process);

    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

    await program.parseAsync(["node", "test", "status", "--watch"]);

    // First interval tick — starts a slow render
    capturedCallback!();
    await new Promise((r) => setTimeout(r, 0));

    const countAfterFirst = renderCount;

    // Second tick while first is still pending — `rendering` guard should block it
    capturedCallback!();
    await new Promise((r) => setTimeout(r, 0));
    expect(renderCount).toBe(countAfterFirst); // no additional list() call

    // Unblock slow render
    unblockSlowRender();
    await new Promise((r) => setTimeout(r, 20));

    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
  });
});
