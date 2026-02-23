import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  type Session,
  type CleanupResult,
  type SessionManager,
  getSessionsDir,
  getProjectBaseDir,
} from "@composio/ao-core";

const {
  mockTmux,
  mockGit,
  mockGh,
  mockExec,
  mockConfigRef,
  mockSessionManager,
  sessionsDirRef,
  mockDetectPR,
  mockGetCISummary,
  mockGetAutomatedComments,
  mockGetSCM,
} = vi.hoisted(() => ({
  mockTmux: vi.fn(),
  mockGit: vi.fn(),
  mockGh: vi.fn(),
  mockExec: vi.fn(),
  mockConfigRef: { current: null as Record<string, unknown> | null },
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
  mockDetectPR: vi.fn(),
  mockGetCISummary: vi.fn(),
  mockGetAutomatedComments: vi.fn(),
  mockGetSCM: vi.fn(),
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

vi.mock("@composio/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@composio/ao-core")>();
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async (): Promise<SessionManager> => mockSessionManager as SessionManager,
}));

vi.mock("../../src/lib/plugins.js", () => ({
  getSCM: (...args: unknown[]) => mockGetSCM(...args),
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
function buildSessionsFromDir(dir: string, projectId: string): Session[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => !f.startsWith(".") && f !== "archive");
  return files.map((name) => {
    const content = readFileSync(join(dir, name), "utf-8");
    const meta = parseMetadata(content);
    return {
      id: name,
      projectId,
      status: (meta["status"] as Session["status"]) || "spawning",
      activity: null,
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

let tmpDir: string;
let configPath: string;
let sessionsDir: string;

import { Command } from "commander";
import { registerSession } from "../../src/commands/session.js";

let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-session-test-"));

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

  // Calculate and create sessions directory for hash-based architecture
  sessionsDir = getSessionsDir(configPath, join(tmpDir, "main-repo"));
  mkdirSync(sessionsDir, { recursive: true });
  sessionsDirRef.current = sessionsDir;

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
  mockDetectPR.mockReset();
  mockDetectPR.mockResolvedValue(null);
  mockGetCISummary.mockReset();
  mockGetCISummary.mockResolvedValue("none");
  mockGetAutomatedComments.mockReset();
  mockGetAutomatedComments.mockResolvedValue([]);
  mockSessionManager.list.mockReset();
  mockSessionManager.kill.mockReset();
  mockSessionManager.cleanup.mockReset();
  mockSessionManager.get.mockReset();
  mockSessionManager.spawn.mockReset();
  mockSessionManager.send.mockReset();
  mockGetSCM.mockReset();

  // Default: getSCM returns a valid mock SCM
  mockGetSCM.mockReturnValue({
    name: "github",
    detectPR: mockDetectPR,
    getCISummary: mockGetCISummary,
    getAutomatedComments: mockGetAutomatedComments,
    getReviewDecision: vi.fn().mockResolvedValue("none"),
    getPendingComments: vi.fn().mockResolvedValue([]),
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
  });

  // Default: list reads from sessionsDir
  mockSessionManager.list.mockImplementation(async () => {
    return buildSessionsFromDir(sessionsDirRef.current, "my-app");
  });

  // Default: kill resolves
  mockSessionManager.kill.mockResolvedValue(undefined);

  // Default: cleanup returns empty
  mockSessionManager.cleanup.mockResolvedValue({
    killed: [],
    skipped: [],
    errors: [],
  } satisfies CleanupResult);
});

afterEach(() => {
  // Clean up hash-based directories in ~/.agent-orchestrator
  const projectBaseDir = getProjectBaseDir(configPath, join(tmpDir, "main-repo"));
  if (existsSync(projectBaseDir)) {
    rmSync(projectBaseDir, { recursive: true, force: true });
  }

  // Clean up tmpDir
  rmSync(tmpDir, { recursive: true, force: true });

  vi.restoreAllMocks();
});

describe("session ls", () => {
  it("shows project name as header when sessions exist", async () => {
    writeFileSync(join(sessionsDir, "app-1"), "branch=main\nstatus=working\n");

    mockTmux.mockResolvedValue(null);
    mockGit.mockResolvedValue(null);

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
    writeFileSync(join(sessionsDir, "app-1"), "branch=feat/INT-100\nstatus=working\n");

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
    writeFileSync(join(sessionsDir, "app-1"), "worktree=/tmp/wt\nbranch=old\nstatus=idle\n");

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
    writeFileSync(
      join(sessionsDir, "app-1"),
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
    mockSessionManager.kill.mockRejectedValue(new Error("Session not found: unknown-1"));

    await expect(
      program.parseAsync(["node", "test", "session", "kill", "unknown-1"]),
    ).rejects.toThrow("process.exit(1)");
  });

  it("kills session and reports success", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "worktree=/tmp/wt\nbranch=feat/fix\nstatus=working\n",
    );

    mockSessionManager.kill.mockResolvedValue(undefined);

    await program.parseAsync(["node", "test", "session", "kill", "app-1"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Session app-1 killed.");
    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1");
  });

  it("calls session manager kill with the session name", async () => {
    writeFileSync(join(sessionsDir, "app-1"), "worktree=/tmp/test-wt\nbranch=main\n");

    mockSessionManager.kill.mockResolvedValue(undefined);

    await program.parseAsync(["node", "test", "session", "kill", "app-1"]);

    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1");
  });
});

describe("session cleanup", () => {
  it("kills sessions with merged PRs", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "branch=feat/fix\nstatus=merged\npr=https://github.com/org/repo/pull/42\n",
    );

    mockSessionManager.cleanup.mockResolvedValue({
      killed: ["app-1"],
      skipped: [],
      errors: [],
    } satisfies CleanupResult);

    await program.parseAsync(["node", "test", "session", "cleanup"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Cleaned: app-1");
    expect(output).toContain("Cleanup complete. 1 sessions cleaned");
  });

  it("does not kill sessions with open PRs", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "branch=feat/fix\nstatus=pr_open\npr=https://github.com/org/repo/pull/42\n",
    );

    mockSessionManager.cleanup.mockResolvedValue({
      killed: [],
      skipped: ["app-1"],
      errors: [],
    } satisfies CleanupResult);

    await program.parseAsync(["node", "test", "session", "cleanup"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No sessions to clean up");
  });

  it("dry run shows what would be cleaned without doing it", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "branch=feat/fix\nstatus=merged\npr=https://github.com/org/repo/pull/42\n",
    );

    // Dry-run now delegates to sm.cleanup({ dryRun: true })
    mockSessionManager.cleanup.mockResolvedValue({
      killed: ["app-1"],
      skipped: [],
      errors: [],
    } satisfies CleanupResult);

    await program.parseAsync(["node", "test", "session", "cleanup", "--dry-run"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Would kill app-1");

    // Metadata should still exist (dry-run doesn't actually kill)
    expect(existsSync(join(sessionsDir, "app-1"))).toBe(true);

    // Verify dryRun option was passed
    expect(mockSessionManager.cleanup).toHaveBeenCalledWith(undefined, { dryRun: true });
  });

  it("reports errors from cleanup", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "branch=feat/a\npr=https://github.com/org/repo/pull/10\n",
    );
    writeFileSync(
      join(sessionsDir, "app-2"),
      "branch=feat/b\npr=https://github.com/org/repo/pull/20\n",
    );

    mockSessionManager.cleanup.mockResolvedValue({
      killed: ["app-2"],
      skipped: [],
      errors: [{ sessionId: "app-1", error: "tmux error" }],
    } satisfies CleanupResult);

    await program.parseAsync(["node", "test", "session", "cleanup"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const errOutput = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    // Error for first session reported
    expect(errOutput).toContain("Error cleaning app-1");
    // Second session cleaned
    expect(output).toContain("Cleaned: app-2");
  });

  it("skips sessions without metadata", async () => {
    // No metadata files exist — list returns empty, cleanup returns empty
    mockSessionManager.cleanup.mockResolvedValue({
      killed: [],
      skipped: [],
      errors: [],
    } satisfies CleanupResult);

    await program.parseAsync(["node", "test", "session", "cleanup"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No sessions to clean up");
  });
});

describe("session table", () => {
  it("prints header and rows in plain text", async () => {
    writeFileSync(join(sessionsDir, "app-1"), "branch=feat/fix\nstatus=working\n");

    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-1",
        projectId: "my-app",
        status: "working",
        activity: "active",
        branch: "feat/fix",
        issueId: null,
        pr: null,
        workspacePath: null,
        runtimeHandle: null,
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: {},
      } satisfies Session,
    ]);

    await program.parseAsync(["node", "test", "session", "table"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("SESSION");
    expect(output).toContain("STATUS");
    expect(output).toContain("ACTIVITY");
    expect(output).toContain("PR_URL");
    expect(output).toContain("app-1");
    expect(output).toContain("working");
    expect(output).toContain("active");
    expect(output).toContain("/sessions/app-1");
  });

  it("shows PR, CI, and bugbot data from SCM", async () => {
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-1",
        projectId: "my-app",
        status: "pr_open",
        activity: "active",
        branch: "feat/test",
        issueId: null,
        pr: null,
        workspacePath: null,
        runtimeHandle: null,
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: { pr: "https://github.com/org/my-app/pull/42" },
      } satisfies Session,
    ]);

    mockDetectPR.mockResolvedValue({
      number: 42,
      url: "https://github.com/org/my-app/pull/42",
      title: "Test PR",
      owner: "org",
      repo: "my-app",
      branch: "feat/test",
      baseBranch: "main",
      isDraft: false,
    });
    mockGetCISummary.mockResolvedValue("passing");
    mockGetAutomatedComments.mockResolvedValue([
      { id: "1", botName: "bugbot", body: "issue", severity: "error", createdAt: new Date(), url: "" },
      { id: "2", botName: "bugbot", body: "issue2", severity: "warning", createdAt: new Date(), url: "" },
    ]);

    await program.parseAsync(["node", "test", "session", "table"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("#42");
    expect(output).toContain("green"); // CI passing
    expect(output).toContain("2"); // 2 bugbot comments
    expect(output).toContain("https://github.com/org/my-app/pull/42");
  });

  it("outputs JSON with --json flag", async () => {
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-1",
        projectId: "my-app",
        status: "working",
        activity: "idle",
        branch: "feat/json",
        issueId: null,
        pr: null,
        workspacePath: null,
        runtimeHandle: null,
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: {},
      } satisfies Session,
    ]);

    await program.parseAsync(["node", "test", "session", "table", "--json"]);

    const jsonCalls = consoleSpy.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(jsonCalls);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].session).toBe("app-1");
    expect(parsed[0].status).toBe("working");
    expect(parsed[0].activity).toBe("idle");
    expect(parsed[0].ci).toBe("-");
    expect(parsed[0].bugbot).toBe(0);
    expect(parsed[0].sessionUrl).toContain("/sessions/app-1");
    expect(parsed[0].prUrl).toBe("");
  });

  it("filters by project with --project flag", async () => {
    mockSessionManager.list.mockResolvedValue([]);

    await program.parseAsync(["node", "test", "session", "table", "-p", "my-app"]);

    expect(mockSessionManager.list).toHaveBeenCalledWith("my-app");
  });

  it("rejects unknown project", async () => {
    await expect(
      program.parseAsync(["node", "test", "session", "table", "-p", "nope"]),
    ).rejects.toThrow("process.exit(1)");
  });

  it("handles SCM errors gracefully", async () => {
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-1",
        projectId: "my-app",
        status: "working",
        activity: "active",
        branch: "feat/err",
        issueId: null,
        pr: null,
        workspacePath: null,
        runtimeHandle: null,
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: { pr: "https://github.com/org/my-app/pull/5" },
      } satisfies Session,
    ]);

    mockDetectPR.mockRejectedValue(new Error("gh failed"));

    await program.parseAsync(["node", "test", "session", "table"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    // Should still show session with fallback PR from metadata
    expect(output).toContain("app-1");
    expect(output).toContain("#5");
    expect(output).toContain("-"); // CI unknown
  });

  it("output contains no ANSI escape codes (machine-readable)", async () => {
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-1",
        projectId: "my-app",
        status: "working",
        activity: "active",
        branch: "feat/ansi",
        issueId: null,
        pr: null,
        workspacePath: null,
        runtimeHandle: null,
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: { pr: "https://github.com/org/my-app/pull/10" },
      } satisfies Session,
    ]);

    await program.parseAsync(["node", "test", "session", "table"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    // eslint-disable-next-line no-control-regex
    expect(output).not.toMatch(/\x1b\[/); // No ANSI escape sequences
  });

  it("header columns align with data columns", async () => {
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-1",
        projectId: "my-app",
        status: "working",
        activity: "active",
        branch: "feat/align",
        issueId: null,
        pr: null,
        workspacePath: null,
        runtimeHandle: null,
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: {},
      } satisfies Session,
    ]);

    await program.parseAsync(["node", "test", "session", "table"]);

    const lines = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const header = lines[0];
    const dataRow = lines[1];

    // Each column in the header should start at the same position as in the data row
    // Verify STATUS column starts at the same offset
    const statusHeaderIdx = header.indexOf("STATUS");
    expect(statusHeaderIdx).toBeGreaterThan(0);
    expect(dataRow.indexOf("working")).toBe(statusHeaderIdx);
  });

  it("sorts sessions alphabetically by id", async () => {
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-3",
        projectId: "my-app",
        status: "working",
        activity: "active",
        branch: "feat/c",
        issueId: null,
        pr: null,
        workspacePath: null,
        runtimeHandle: null,
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: {},
      } satisfies Session,
      {
        id: "app-1",
        projectId: "my-app",
        status: "pr_open",
        activity: "idle",
        branch: "feat/a",
        issueId: null,
        pr: null,
        workspacePath: null,
        runtimeHandle: null,
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: {},
      } satisfies Session,
    ]);

    await program.parseAsync(["node", "test", "session", "table"]);

    const lines = consoleSpy.mock.calls.map((c) => String(c[0]));
    // Header is line 0, data starts at line 1
    const dataLines = lines.slice(1);
    const firstData = dataLines.find((l) => l.includes("app-"));
    const secondData = dataLines.filter((l) => l.includes("app-"))[1];
    expect(firstData).toContain("app-1");
    expect(secondData).toContain("app-3");
  });

  it("handles unknown SCM plugin without crashing", async () => {
    mockGetSCM.mockImplementation(() => {
      throw new Error("Unknown SCM plugin: bad-scm");
    });

    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-1",
        projectId: "my-app",
        status: "working",
        activity: "active",
        branch: "feat/scm-err",
        issueId: null,
        pr: null,
        workspacePath: null,
        runtimeHandle: null,
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: { pr: "https://github.com/org/my-app/pull/5" },
      } satisfies Session,
    ]);

    await program.parseAsync(["node", "test", "session", "table"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    // Should still show session with metadata-fallback PR data
    expect(output).toContain("app-1");
    expect(output).toContain("#5");
    expect(output).toContain("-"); // CI unknown (no SCM)
  });
});
