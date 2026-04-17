import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSessionManager } from "../../session-manager.js";
import { readMetadataRaw, writeMetadata } from "../../metadata.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  Runtime,
  Agent,
  Session,
  ProjectConfig,
} from "../../types.js";
import {
  setupTestContext,
  teardownTestContext,
  makeHandle,
  type TestContext,
} from "../test-utils.js";

let ctx: TestContext;
let sessionsDir: string;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;

beforeEach(() => {
  ctx = setupTestContext();
  ({
    sessionsDir,
    mockRuntime,
    mockAgent,
    mockRegistry,
    config,
  } = ctx);
});

afterEach(() => {
  teardownTestContext(ctx);
  vi.restoreAllMocks();
});

/** Write an archived session metadata file. */
function createArchive(
  sessionId: string,
  data: Record<string, string>,
  timestamp = "2025-01-15T12-00-00-000Z",
): void {
  const archiveDir = join(sessionsDir, "archive");
  mkdirSync(archiveDir, { recursive: true });
  const content = Object.entries(data)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";
  writeFileSync(join(archiveDir, `${sessionId}_${timestamp}`), content);
}

describe("spawn — resume strategy (default)", () => {
  it("calls getRestoreCommand when archive exists for same issue + agent", async () => {
    createArchive("app-1", {
      agent: "mock-agent",
      issue: "INT-100",
      status: "killed",
      branch: "feat/INT-100",
      worktree: "/old/path",
      project: "my-app",
    });

    const mockGetRestore = vi.fn().mockResolvedValue("mock-agent --resume session-abc");
    mockAgent.getRestoreCommand = mockGetRestore;

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    expect(mockGetRestore).toHaveBeenCalled();
    expect(mockAgent.getLaunchCommand).not.toHaveBeenCalled();
    // Runtime should be created with the restore command
    expect(mockRuntime.create).toHaveBeenCalledWith(
      expect.objectContaining({
        launchCommand: "mock-agent --resume session-abc",
      }),
    );
  });

  it("falls back to getLaunchCommand when getRestoreCommand returns null", async () => {
    createArchive("app-1", {
      agent: "mock-agent",
      issue: "INT-100",
      status: "killed",
      branch: "feat/INT-100",
      worktree: "/old/path",
      project: "my-app",
    });

    mockAgent.getRestoreCommand = vi.fn().mockResolvedValue(null);

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    expect(mockAgent.getRestoreCommand).toHaveBeenCalled();
    expect(mockAgent.getLaunchCommand).toHaveBeenCalled();
  });

  it("falls back to getLaunchCommand when getRestoreCommand throws", async () => {
    createArchive("app-1", {
      agent: "mock-agent",
      issue: "INT-100",
      status: "killed",
      branch: "feat/INT-100",
      worktree: "/old/path",
      project: "my-app",
    });

    mockAgent.getRestoreCommand = vi.fn().mockRejectedValue(new Error("session corrupted"));

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    expect(mockAgent.getRestoreCommand).toHaveBeenCalled();
    expect(mockAgent.getLaunchCommand).toHaveBeenCalled();
  });

  it("does not attempt restore when no archived session exists", async () => {
    mockAgent.getRestoreCommand = vi.fn().mockResolvedValue("mock-agent --resume x");

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-200" });

    expect(mockAgent.getRestoreCommand).not.toHaveBeenCalled();
    expect(mockAgent.getLaunchCommand).toHaveBeenCalled();
  });

  it("skips restore when agent has no getRestoreCommand but injects context", async () => {
    createArchive("app-1", {
      agent: "mock-agent",
      issue: "INT-100",
      status: "killed",
      branch: "feat/INT-100",
      worktree: "/old/path",
      project: "my-app",
      summary: "Fixed the auth module",
    });

    // Ensure no getRestoreCommand exists
    delete mockAgent.getRestoreCommand;

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    expect(mockAgent.getLaunchCommand).toHaveBeenCalled();
    // The prompt should contain the context injection
    const launchConfig = vi.mocked(mockAgent.getLaunchCommand).mock.calls[0][0];
    expect(launchConfig.prompt).toContain("## Previous Session Context");
    expect(launchConfig.prompt).toContain("Fixed the auth module");
  });

  it("does not attempt restore when no issueId is provided", async () => {
    createArchive("app-1", {
      agent: "mock-agent",
      issue: "INT-100",
      status: "killed",
      branch: "feat/INT-100",
      worktree: "/old/path",
      project: "my-app",
    });

    mockAgent.getRestoreCommand = vi.fn().mockResolvedValue("mock-agent --resume x");

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app" });

    expect(mockAgent.getRestoreCommand).not.toHaveBeenCalled();
  });

  it("uses workspace.restore() when attempting native resume (Gap 1&2)", async () => {
    createArchive("app-1", {
      agent: "mock-agent",
      issue: "INT-100",
      status: "killed",
      branch: "feat/INT-100",
      worktree: "/old/worktree/path",
      project: "my-app",
    });

    mockAgent.getRestoreCommand = vi.fn().mockResolvedValue("mock-agent --resume x");
    const mockRestore = vi.fn().mockResolvedValue({
      path: "/old/worktree/path",
      branch: "feat/INT-100",
      sessionId: "app-2",
      projectId: "my-app",
    });
    ctx.mockWorkspace.restore = mockRestore;

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    // Should use workspace.restore() not workspace.create()
    expect(mockRestore).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "feat/INT-100" }),
      "/old/worktree/path",
    );
  });

  it("falls back to workspace.create() when workspace.restore() fails", async () => {
    createArchive("app-1", {
      agent: "mock-agent",
      issue: "INT-100",
      status: "killed",
      branch: "feat/INT-100",
      worktree: "/old/worktree/path",
      project: "my-app",
    });

    mockAgent.getRestoreCommand = vi.fn().mockResolvedValue("mock-agent --resume x");
    ctx.mockWorkspace.restore = vi.fn().mockRejectedValue(new Error("worktree gone"));

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    // Should fall back to create() and getLaunchCommand() (native resume abandoned)
    expect(ctx.mockWorkspace.create).toHaveBeenCalled();
    expect(mockAgent.getLaunchCommand).toHaveBeenCalled();
  });

  it("writes resumedFrom to metadata on successful resume", async () => {
    createArchive("app-1", {
      agent: "mock-agent",
      issue: "INT-100",
      status: "killed",
      branch: "feat/INT-100",
      worktree: "/old/path",
      project: "my-app",
    });

    mockAgent.getRestoreCommand = vi.fn().mockResolvedValue("mock-agent --resume x");

    const sm = createSessionManager({ config, registry: mockRegistry });
    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    const raw = readMetadataRaw(sessionsDir, session.id);
    expect(raw?.["resumedFrom"]).toBe("app-1");
  });

  it("does not write resumedFrom on fresh launch", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-200" });

    const raw = readMetadataRaw(sessionsDir, session.id);
    expect(raw?.["resumedFrom"]).toBeUndefined();
  });

  it("only matches archives with the same agent name", async () => {
    createArchive("app-1", {
      agent: "codex",
      issue: "INT-100",
      status: "killed",
      branch: "feat/INT-100",
      worktree: "/old/path",
      project: "my-app",
    });

    mockAgent.getRestoreCommand = vi.fn().mockResolvedValue("mock-agent --resume x");

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    // Agent name mismatch → no restore attempt
    expect(mockAgent.getRestoreCommand).not.toHaveBeenCalled();
  });

  it("picks the most recent archive when multiple exist for the same issue", async () => {
    createArchive("app-1", {
      agent: "mock-agent",
      issue: "INT-100",
      status: "killed",
      branch: "feat/INT-100",
      worktree: "/old/path",
      project: "my-app",
      summary: "older session",
    }, "2025-01-10T12-00-00-000Z");

    createArchive("app-3", {
      agent: "mock-agent",
      issue: "INT-100",
      status: "errored",
      branch: "feat/INT-100",
      worktree: "/old/path",
      project: "my-app",
      summary: "newer session",
    }, "2025-01-15T12-00-00-000Z");

    const mockGetRestore = vi.fn().mockResolvedValue("mock-agent --resume newer");
    mockAgent.getRestoreCommand = mockGetRestore;

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    // Should try to restore from app-3 (most recent by sortSessionIdsForReuse)
    expect(mockGetRestore).toHaveBeenCalled();
    const sessionArg = mockGetRestore.mock.calls[0][0] as Session;
    expect(sessionArg.id).toBe("app-3");
  });

  it("injects context when getRestoreCommand returns null (fallback)", async () => {
    createArchive("app-1", {
      agent: "mock-agent",
      issue: "INT-100",
      status: "killed",
      branch: "feat/INT-100",
      worktree: "/old/path",
      project: "my-app",
      summary: "Partially fixed the issue",
      pr: "https://github.com/org/repo/pull/42",
    });

    mockAgent.getRestoreCommand = vi.fn().mockResolvedValue(null);

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    const launchConfig = vi.mocked(mockAgent.getLaunchCommand).mock.calls[0][0];
    expect(launchConfig.prompt).toContain("## Previous Session Context");
    expect(launchConfig.prompt).toContain("Partially fixed the issue");
  });

  // Gap 5: done sessions should NOT be used for native resume
  it("does not attempt native resume for done sessions", async () => {
    createArchive("app-1", {
      agent: "mock-agent",
      issue: "INT-100",
      status: "done",
      branch: "feat/INT-100",
      worktree: "/old/path",
      project: "my-app",
      summary: "Completed task",
      pr: "https://github.com/org/repo/pull/42",
    });

    mockAgent.getRestoreCommand = vi.fn().mockResolvedValue("mock-agent --resume x");

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    // getRestoreCommand should NOT be called for done sessions
    expect(mockAgent.getRestoreCommand).not.toHaveBeenCalled();
    // But context injection should work
    const launchConfig = vi.mocked(mockAgent.getLaunchCommand).mock.calls[0][0];
    expect(launchConfig.prompt).toContain("completed normally");
  });

  // Gap 6: merged sessions should be filtered out entirely
  it("does not match merged sessions", async () => {
    createArchive("app-1", {
      agent: "mock-agent",
      issue: "INT-100",
      status: "merged",
      branch: "feat/INT-100",
      worktree: "/old/path",
      project: "my-app",
      summary: "Work landed",
    });

    mockAgent.getRestoreCommand = vi.fn().mockResolvedValue("mock-agent --resume x");

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    expect(mockAgent.getRestoreCommand).not.toHaveBeenCalled();
    // No context injection either — merged work already landed
    const launchConfig = vi.mocked(mockAgent.getLaunchCommand).mock.calls[0][0];
    expect(launchConfig.prompt).not.toContain("## Previous Session Context");
  });

  // Gap 3: active session dedup guard
  it("throws when an active session already exists for the same issue", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/ws",
      branch: "feat/INT-100",
      status: "working",
      project: "my-app",
      agent: "mock-agent",
      issue: "INT-100",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.spawn({ projectId: "my-app", issueId: "INT-100" })).rejects.toThrow(
      /already exists for issue INT-100/,
    );
    // No resources should be created
    expect(mockRuntime.create).not.toHaveBeenCalled();
  });

  it("uses richer done session for context injection when native resume fails", async () => {
    // Older killed session (resumable)
    createArchive("app-1", {
      agent: "mock-agent",
      issue: "INT-100",
      status: "killed",
      branch: "feat/INT-100",
      worktree: "/old/path",
      project: "my-app",
      summary: "Sparse summary",
    }, "2025-01-10T12-00-00-000Z");

    // Newer done session (richer context with PR)
    createArchive("app-2", {
      agent: "mock-agent",
      issue: "INT-100",
      status: "done",
      branch: "feat/INT-100",
      worktree: "/old/path",
      project: "my-app",
      summary: "Full implementation done",
      pr: "https://github.com/org/repo/pull/99",
    }, "2025-01-15T12-00-00-000Z");

    // Native resume matches killed session (app-1) but then fails
    mockAgent.getRestoreCommand = vi.fn().mockResolvedValue(null);

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    // Context injection should use the richer done session (app-2), not the killed one (app-1)
    const launchConfig = vi.mocked(mockAgent.getLaunchCommand).mock.calls[0][0];
    expect(launchConfig.prompt).toContain("pull/99");
    expect(launchConfig.prompt).toContain("completed normally");
  });

  it("allows spawn when active session is for a different issue", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/ws",
      branch: "feat/INT-200",
      status: "working",
      project: "my-app",
      agent: "mock-agent",
      issue: "INT-200",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });
    expect(session.id).toBeDefined();
  });
});

describe("spawn — context-inject strategy", () => {
  beforeEach(() => {
    (config.projects["my-app"] as ProjectConfig).workerRespawnStrategy = "context-inject";
  });

  it("skips getRestoreCommand entirely", async () => {
    createArchive("app-1", {
      agent: "mock-agent",
      issue: "INT-100",
      status: "killed",
      branch: "feat/INT-100",
      worktree: "/old/path",
      project: "my-app",
      summary: "work done",
    });

    mockAgent.getRestoreCommand = vi.fn().mockResolvedValue("mock-agent --resume x");

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    expect(mockAgent.getRestoreCommand).not.toHaveBeenCalled();
    expect(mockAgent.getLaunchCommand).toHaveBeenCalled();
  });

  it("injects context into prompt", async () => {
    createArchive("app-1", {
      agent: "mock-agent",
      issue: "INT-100",
      status: "killed",
      branch: "feat/INT-100",
      worktree: "/old/path",
      project: "my-app",
      summary: "Worked on the login flow",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    const launchConfig = vi.mocked(mockAgent.getLaunchCommand).mock.calls[0][0];
    expect(launchConfig.prompt).toContain("## Previous Session Context");
    expect(launchConfig.prompt).toContain("Worked on the login flow");
  });

  it("falls back to fresh when no meaningful context exists", async () => {
    createArchive("app-1", {
      agent: "mock-agent",
      issue: "INT-100",
      status: "killed",
      branch: "feat/INT-100",
      worktree: "/old/path",
      project: "my-app",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    const launchConfig = vi.mocked(mockAgent.getLaunchCommand).mock.calls[0][0];
    expect(launchConfig.prompt).not.toContain("## Previous Session Context");
  });
});

describe("spawn — fresh strategy", () => {
  beforeEach(() => {
    (config.projects["my-app"] as ProjectConfig).workerRespawnStrategy = "fresh";
  });

  it("never attempts resume even when archive exists", async () => {
    createArchive("app-1", {
      agent: "mock-agent",
      issue: "INT-100",
      status: "killed",
      branch: "feat/INT-100",
      worktree: "/old/path",
      project: "my-app",
      summary: "work done",
    });

    mockAgent.getRestoreCommand = vi.fn().mockResolvedValue("mock-agent --resume x");

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    expect(mockAgent.getRestoreCommand).not.toHaveBeenCalled();
    const launchConfig = vi.mocked(mockAgent.getLaunchCommand).mock.calls[0][0];
    expect(launchConfig.prompt).not.toContain("## Previous Session Context");
  });
});
