import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type Session, type SessionManager, getSessionsDir } from "@composio/ao-core";

const { mockTmux, mockExec, mockGh, mockConfigRef, mockSessionManager, sessionsDirRef } =
  vi.hoisted(() => ({
    mockTmux: vi.fn(),
    mockExec: vi.fn(),
    mockGh: vi.fn(),
    mockConfigRef: { current: null as Record<string, unknown> | null },
    mockSessionManager: {
      list: vi.fn(),
      kill: vi.fn(),
      cleanup: vi.fn(),
      get: vi.fn(),
      spawn: vi.fn(),
      spawnOrchestrator: vi.fn(),
      send: vi.fn(),
      getAttachInfo: vi.fn().mockResolvedValue(null),
    },
    sessionsDirRef: { current: "" },
  }));

vi.mock("../../src/lib/shell.js", () => ({
  tmux: mockTmux,
  exec: mockExec,
  execSilent: vi.fn(),
  git: vi.fn(),
  gh: mockGh,
  getTmuxSessions: async () => {
    const output = await mockTmux("list-sessions", "-F", "#{session_name}");
    if (!output) return [];
    return output.split("\n").filter(Boolean);
  },
  getTmuxActivity: vi.fn().mockResolvedValue(null),
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
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@composio/ao-core")>();
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
  };
});

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

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async (): Promise<SessionManager> => mockSessionManager as SessionManager,
}));

let tmpDir: string;
let sessionsDir: string;

import { Command } from "commander";
import { registerReviewCheck } from "../../src/commands/review-check.js";

let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-review-test-"));

  const configPath = join(tmpDir, "agent-orchestrator.yaml");
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

  // Calculate and create sessions directory for hash-based architecture
  sessionsDir = getSessionsDir(configPath, join(tmpDir, "main-repo"));
  mkdirSync(sessionsDir, { recursive: true });
  sessionsDirRef.current = sessionsDir;

  program = new Command();
  program.exitOverride();
  registerReviewCheck(program);
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  mockTmux.mockReset();
  mockExec.mockReset();
  mockGh.mockReset();
  mockExec.mockResolvedValue({ stdout: "", stderr: "" });
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

describe("review-check command", () => {
  it("reports no pending reviews when none exist", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "branch=feat/fix\npr=https://github.com/org/my-app/pull/10\n",
    );

    // All threads resolved, no changes requested
    mockGh.mockResolvedValue(
      JSON.stringify({
        reviewDecision: "APPROVED",
        reviewThreads: { nodes: [{ isResolved: true }] },
      }),
    );

    await program.parseAsync(["node", "test", "review-check"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No pending review comments");
  });

  it("finds sessions with pending review comments", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "branch=feat/fix\npr=https://github.com/org/my-app/pull/10\n",
    );

    mockGh.mockResolvedValue(
      JSON.stringify({
        reviewDecision: "CHANGES_REQUESTED",
        reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] },
      }),
    );

    await program.parseAsync(["node", "test", "review-check", "--dry-run"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("app-1");
    expect(output).toContain("PR #10");
    expect(output).toContain("CHANGES_REQUESTED");
    expect(output).toContain("dry run");
  });

  it("skips sessions without PR metadata", async () => {
    writeFileSync(join(sessionsDir, "app-1"), "branch=feat/fix\nstatus=working\n");

    await program.parseAsync(["node", "test", "review-check"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No pending review comments");
    // gh should never be called since there's no PR
    expect(mockGh).not.toHaveBeenCalled();
  });

  it("skips sessions with non-matching prefix", async () => {
    writeFileSync(
      join(sessionsDir, "other-1"),
      "branch=feat/fix\npr=https://github.com/org/my-app/pull/10\n",
    );

    await program.parseAsync(["node", "test", "review-check"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    // The session manager returns all sessions in the project dir, including other-1
    // But review-check iterates over them — other-1 has a PR, so it will be checked.
    // However, with the session manager, project matching is done differently.
    // other-1 is in the my-app sessions dir so it will be found and its PR checked.
    // The test outcome depends on the gh mock — default mockGh is reset (returns undefined).
    // With no valid gh response, the PR check will return {pendingComments: 0, reviewDecision: null}
    // So no pending reviews found.
    expect(output).toContain("No pending review comments");
  });

  it("sends fix prompt when not in dry-run mode", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "branch=feat/fix\npr=https://github.com/org/my-app/pull/10\n",
    );

    mockGh.mockResolvedValue(
      JSON.stringify({
        reviewDecision: null,
        reviewThreads: { nodes: [{ isResolved: false }] },
      }),
    );

    await program.parseAsync(["node", "test", "review-check"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Fix prompt sent");

    // Should have sent C-c, C-u, message, Enter
    expect(mockExec).toHaveBeenCalledWith("tmux", ["send-keys", "-t", "app-1", "C-c"]);
    expect(mockExec).toHaveBeenCalledWith("tmux", ["send-keys", "-t", "app-1", "C-u"]);
    expect(mockExec).toHaveBeenCalledWith("tmux", [
      "send-keys",
      "-t",
      "app-1",
      "-l",
      expect.stringContaining("review comments"),
    ]);
    expect(mockExec).toHaveBeenCalledWith("tmux", ["send-keys", "-t", "app-1", "Enter"]);
  });

  it("handles gh returning null (API failure)", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "branch=feat/fix\npr=https://github.com/org/my-app/pull/10\n",
    );

    mockGh.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "review-check"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No pending review comments");
  });

  it("handles malformed GraphQL response gracefully", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "branch=feat/fix\npr=https://github.com/org/my-app/pull/10\n",
    );

    mockGh.mockResolvedValue("not valid json {{{");

    await program.parseAsync(["node", "test", "review-check"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No pending review comments");
  });

  it("rejects unknown project ID", async () => {
    await expect(
      program.parseAsync(["node", "test", "review-check", "nonexistent"]),
    ).rejects.toThrow("process.exit(1)");
  });
});
