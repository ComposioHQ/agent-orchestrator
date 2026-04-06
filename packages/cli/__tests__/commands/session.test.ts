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
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type * as ChildProcessModule from "node:child_process";
import {
  type Session,
  type CleanupResult,
  type SessionManager,
  SessionNotFoundError,
  getSessionsDir,
  getProjectBaseDir,
} from "@composio/ao-core";

const {
  mockTmux,
  mockGit,
  mockGh,
  mockExec,
  mockSpawn,
  mockConfigRef,
  mockSessionManager,
  sessionsDirRef,
} = vi.hoisted(() => ({
  mockTmux: vi.fn(),
  mockGit: vi.fn(),
  mockGh: vi.fn(),
  mockExec: vi.fn(),
  mockSpawn: vi.fn(),
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
  sessionsDirRef: { current: "" },
}));

function makeMockChild(exitCode: number): EventEmitter {
  const child = new EventEmitter();
  queueMicrotask(() => {
    child.emit("exit", exitCode);
  });
  return child;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

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
  mockSpawn.mockReset();
  mockSessionManager.list.mockReset();
  mockSessionManager.kill.mockReset();
  mockSessionManager.cleanup.mockReset();
  mockSessionManager.restore.mockReset();
  mockSessionManager.remap.mockReset();
  mockSessionManager.get.mockReset();
  mockSessionManager.spawn.mockReset();
  mockSessionManager.send.mockReset();
  mockSessionManager.claimPR.mockReset();

  mockSpawn.mockImplementation(() => makeMockChild(0));

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
  mockSessionManager.restore.mockResolvedValue(undefined);
  mockSessionManager.remap.mockResolvedValue("ses_mock");
  mockSessionManager.claimPR.mockResolvedValue({
    sessionId: "app-1",
    projectId: "my-app",
    pr: {
      number: 42,
      url: "https://github.com/org/repo/pull/42",
      title: "Existing PR",
      owner: "org",
      repo: "repo",
      branch: "feat/existing-pr",
      baseBranch: "main",
      isDraft: false,
    },
    branchChanged: true,
    githubAssigned: false,
    takenOverFrom: [],
  });
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
    mockSessionManager.kill.mockRejectedValue(new SessionNotFoundError("unknown-1"));

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
    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1", { purgeOpenCode: false });
  });

  it("calls session manager kill with the session name", async () => {
    writeFileSync(join(sessionsDir, "app-1"), "worktree=/tmp/test-wt\nbranch=main\n");

    mockSessionManager.kill.mockResolvedValue(undefined);

    await program.parseAsync(["node", "test", "session", "kill", "app-1"]);

    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1", { purgeOpenCode: false });
  });

  it("passes purge flag for OpenCode cleanup", async () => {
    mockSessionManager.kill.mockResolvedValue(undefined);

    await program.parseAsync(["node", "test", "session", "kill", "app-1", "--purge-session"]);

    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1", { purgeOpenCode: true });
  });
});

describe("session attach", () => {
  it("attaches to resolved runtime target when session exists", async () => {
    mockSessionManager.get.mockResolvedValue({
      id: "app-1",
      projectId: "my-app",
      status: "working",
      activity: null,
      branch: null,
      issueId: null,
      pr: null,
      workspacePath: null,
      runtimeHandle: { id: "tmux-target-1", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    } satisfies Session);

    mockTmux.mockResolvedValue("");

    await program.parseAsync(["node", "test", "session", "attach", "app-1"]);

    expect(mockTmux).toHaveBeenCalledWith("has-session", "-t", "tmux-target-1");
    expect(mockSpawn).toHaveBeenCalledWith("tmux", ["attach", "-t", "tmux-target-1"], {
      stdio: "inherit",
    });
  });

  it("fails when tmux session does not exist", async () => {
    mockSessionManager.get.mockResolvedValue(null);
    mockTmux.mockResolvedValue(null);

    await expect(
      program.parseAsync(["node", "test", "session", "attach", "unknown-1"]),
    ).rejects.toThrow("process.exit(1)");
  });
});

describe("session claim-pr", () => {
  afterEach(() => {
    delete process.env["AO_SESSION_NAME"];
    delete process.env["AO_SESSION"];
  });

  it("claims a PR for an explicit session", async () => {
    await program.parseAsync([
      "node",
      "test",
      "session",
      "claim-pr",
      "42",
      "app-2",
      "--assign-on-github",
    ]);

    expect(mockSessionManager.claimPR).toHaveBeenCalledWith("app-2", "42", {
      assignOnGithub: true,
    });

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Session app-2 claimed PR #42");
    expect(output).toContain("feat/existing-pr");
  });

  it("uses AO_SESSION_NAME when session argument is omitted", async () => {
    process.env["AO_SESSION_NAME"] = "app-7";

    await program.parseAsync(["node", "test", "session", "claim-pr", "42"]);

    expect(mockSessionManager.claimPR).toHaveBeenCalledWith("app-7", "42", {
      assignOnGithub: undefined,
    });
  });

  it("fails when no session can be resolved", async () => {
    await expect(program.parseAsync(["node", "test", "session", "claim-pr", "42"])).rejects.toThrow(
      "process.exit(1)",
    );
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

  it("suppresses orchestrator cleanup output while preserving worker cleanup output", async () => {
    mockSessionManager.cleanup.mockResolvedValue({
      killed: ["app-orchestrator", "app-2"],
      skipped: [],
      errors: [{ sessionId: "app-orchestrator", error: "should never surface" }],
    } satisfies CleanupResult);

    await program.parseAsync(["node", "test", "session", "cleanup"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const errOutput = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");

    expect(output).toContain("Cleaned: app-2");
    expect(output).not.toContain("app-orchestrator");
    expect(output).toContain("Cleanup complete. 1 sessions cleaned");
    expect(errOutput).not.toContain("app-orchestrator");
  });

  it("treats orchestrator-only cleanup results as no-op output", async () => {
    mockSessionManager.cleanup.mockResolvedValue({
      killed: ["app-orchestrator"],
      skipped: [],
      errors: [],
    } satisfies CleanupResult);

    await program.parseAsync(["node", "test", "session", "cleanup"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No sessions to clean up");
    expect(output).not.toContain("app-orchestrator");
  });

  it("suppresses orchestrators in cleanup dry-run output", async () => {
    mockSessionManager.cleanup.mockResolvedValue({
      killed: ["app-orchestrator", "app-3"],
      skipped: [],
      errors: [],
    } satisfies CleanupResult);

    await program.parseAsync(["node", "test", "session", "cleanup", "--dry-run"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Would kill app-3");
    expect(output).not.toContain("app-orchestrator");
    expect(output).toContain("1 session would be cleaned");
  });

  it("suppresses project-prefixed orchestrator cleanup results", async () => {
    mockSessionManager.cleanup.mockResolvedValue({
      killed: ["my-app:app-orchestrator", "my-app:app-4"],
      skipped: [],
      errors: [{ sessionId: "my-app:app-orchestrator", error: "should never surface" }],
    } satisfies CleanupResult);

    await program.parseAsync(["node", "test", "session", "cleanup"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const errOutput = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");

    expect(output).toContain("Cleaned: my-app:app-4");
    expect(output).not.toContain("my-app:app-orchestrator");
    expect(output).toContain("Cleanup complete. 1 sessions cleaned");
    expect(errOutput).not.toContain("my-app:app-orchestrator");
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

describe("session remap", () => {
  it("remaps OpenCode session and reports mapped id", async () => {
    mockSessionManager.remap.mockResolvedValue("ses_123");

    await program.parseAsync(["node", "test", "session", "remap", "app-1"]);

    expect(mockSessionManager.remap).toHaveBeenCalledWith("app-1", false);
    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Session app-1 remapped.");
    expect(output).toContain("OpenCode session: ses_123");
  });

  it("passes force flag to remap", async () => {
    mockSessionManager.remap.mockResolvedValue("ses_123");

    await program.parseAsync(["node", "test", "session", "remap", "app-1", "--force"]);

    expect(mockSessionManager.remap).toHaveBeenCalledWith("app-1", true);
  });

  it("fails with exit code when remap errors", async () => {
    mockSessionManager.remap.mockRejectedValue(new Error("mapping failed"));

    await expect(program.parseAsync(["node", "test", "session", "remap", "app-1"])).rejects.toThrow(
      "process.exit(1)",
    );
  });
});
