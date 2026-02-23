import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createPhaseManager } from "../phase-manager.js";
import { readMetadataRaw, writeMetadata } from "../metadata.js";
import { writePlanArtifact, writeReviewArtifact } from "../review-artifacts.js";
import type { OrchestratorConfig, Session, SessionManager } from "../types.js";
import { SESSION_PHASE } from "../types.js";
import { getSessionsDir, getProjectBaseDir } from "../paths.js";

let tmpDir: string;
let configPath: string;
let sessionsDir: string;
let config: OrchestratorConfig;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "working",
    phase: SESSION_PHASE.PLANNING,
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: join(tmpDir, "my-app"),
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: { reviewRound: "1", phase: SESSION_PHASE.PLANNING },
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-phase-manager-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  config = {
    configPath,
    port: 3000,
    defaults: {
      runtime: "mock",
      agent: "mock-agent",
      workspace: "mock-ws",
      notifiers: [],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: join(tmpDir, "my-app"),
        defaultBranch: "main",
        sessionPrefix: "app",
        workflow: { mode: "full", autoCodeReview: true },
      },
    },
    notifiers: {},
    notificationRouting: {
      urgent: [],
      action: [],
      warning: [],
      info: [],
    },
    reactions: {},
    readyThresholdMs: 300_000,
  };

  mkdirSync(join(tmpDir, "my-app"), { recursive: true });
  sessionsDir = getSessionsDir(configPath, join(tmpDir, "my-app"));
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  const projectBaseDir = getProjectBaseDir(configPath, join(tmpDir, "my-app"));
  rmSync(projectBaseDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("phase manager transitions", () => {
  it("does not transition for simple workflow mode", async () => {
    config.projects["my-app"] = {
      ...config.projects["my-app"]!,
      workflow: { mode: "simple", autoCodeReview: true },
    };
    const phaseManager = createPhaseManager({ config });
    const session = makeSession({ phase: SESSION_PHASE.PLANNING });

    writeMetadata(sessionsDir, session.id, {
      worktree: session.workspacePath ?? "",
      branch: session.branch ?? "",
      status: session.status,
      phase: session.phase,
      project: session.projectId,
    });
    writePlanArtifact(session.workspacePath ?? "", "# Plan");

    const phase = await phaseManager.check(session);
    expect(phase).toBe(SESSION_PHASE.PLANNING);
  });

  it("transitions planning to plan_review when plan exists", async () => {
    const phaseManager = createPhaseManager({ config });
    const session = makeSession({ phase: SESSION_PHASE.PLANNING });

    writeMetadata(sessionsDir, session.id, {
      worktree: session.workspacePath ?? "",
      branch: session.branch ?? "",
      status: session.status,
      phase: session.phase,
      project: session.projectId,
    });
    writePlanArtifact(session.workspacePath ?? "", "# Plan\n\ntext");

    const phase = await phaseManager.check(session);
    expect(phase).toBe(SESSION_PHASE.PLAN_REVIEW);

    const raw = readMetadataRaw(sessionsDir, session.id);
    expect(raw?.["phase"]).toBe(SESSION_PHASE.PLAN_REVIEW);
    expect(raw?.["reviewRound"]).toBe("1");
  });

  it("transitions plan_review to implementing when all reviewers approved", async () => {
    const phaseManager = createPhaseManager({ config });
    const session = makeSession({
      phase: SESSION_PHASE.PLAN_REVIEW,
      metadata: { phase: SESSION_PHASE.PLAN_REVIEW, reviewRound: "1" },
    });

    writeMetadata(sessionsDir, session.id, {
      worktree: session.workspacePath ?? "",
      branch: session.branch ?? "",
      status: session.status,
      phase: session.phase,
      reviewRound: "1",
      project: session.projectId,
    });

    writeReviewArtifact(session.workspacePath ?? "", {
      phase: "plan_review",
      round: 1,
      role: "architect",
      decision: "approved",
      timestamp: "2026-02-23T10:30:00Z",
      content: "ok",
    });
    writeReviewArtifact(session.workspacePath ?? "", {
      phase: "plan_review",
      round: 1,
      role: "developer",
      decision: "approved",
      timestamp: "2026-02-23T10:31:00Z",
      content: "ok",
    });
    writeReviewArtifact(session.workspacePath ?? "", {
      phase: "plan_review",
      round: 1,
      role: "product",
      decision: "approved",
      timestamp: "2026-02-23T10:32:00Z",
      content: "ok",
    });

    const phase = await phaseManager.check(session);
    expect(phase).toBe(SESSION_PHASE.IMPLEMENTING);
    expect(readMetadataRaw(sessionsDir, session.id)?.["phase"]).toBe(SESSION_PHASE.IMPLEMENTING);
  });

  it("transitions plan_review back to planning when changes requested", async () => {
    const phaseManager = createPhaseManager({ config });
    const session = makeSession({
      phase: SESSION_PHASE.PLAN_REVIEW,
      metadata: { phase: SESSION_PHASE.PLAN_REVIEW, reviewRound: "2" },
    });

    writeMetadata(sessionsDir, session.id, {
      worktree: session.workspacePath ?? "",
      branch: session.branch ?? "",
      status: session.status,
      phase: session.phase,
      reviewRound: "2",
      project: session.projectId,
    });

    writeReviewArtifact(session.workspacePath ?? "", {
      phase: "plan_review",
      round: 2,
      role: "architect",
      decision: "changes_requested",
      timestamp: "2026-02-23T10:30:00Z",
      content: "needs changes",
    });

    const phase = await phaseManager.check(session);
    expect(phase).toBe(SESSION_PHASE.PLANNING);

    const raw = readMetadataRaw(sessionsDir, session.id);
    expect(raw?.["phase"]).toBe(SESSION_PHASE.PLANNING);
    expect(raw?.["reviewRound"]).toBe("3");
  });

  it("spawns plan-review sub-sessions when no review artifacts exist", async () => {
    const mockSessionManager = {
      list: vi.fn().mockResolvedValue([]),
      spawn: vi.fn().mockResolvedValue(makeSession({ id: "app-2", phase: SESSION_PHASE.PLAN_REVIEW })),
    } as unknown as SessionManager;
    const phaseManager = createPhaseManager({ config, sessionManager: mockSessionManager });
    const session = makeSession({
      phase: SESSION_PHASE.PLAN_REVIEW,
      issueId: "INT-42",
      metadata: { phase: SESSION_PHASE.PLAN_REVIEW, reviewRound: "1" },
    });

    writeMetadata(sessionsDir, session.id, {
      worktree: session.workspacePath ?? "",
      branch: session.branch ?? "",
      status: session.status,
      phase: session.phase,
      reviewRound: "1",
      issue: "INT-42",
      project: session.projectId,
    });
    writePlanArtifact(session.workspacePath ?? "", "# Plan\n\nShip feature X");

    const phase = await phaseManager.check(session);
    expect(phase).toBe(SESSION_PHASE.PLAN_REVIEW);

    const spawnMock = vi.mocked(mockSessionManager.spawn);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    const roles = spawnMock.mock.calls.map((call) => call[0].subSessionInfo?.role).sort();
    expect(roles).toEqual(["architect", "developer", "product"]);
    expect(spawnMock.mock.calls[0]?.[0].phase).toBe(SESSION_PHASE.PLAN_REVIEW);
  });

  it("does not spawn reviewers already running for the same round", async () => {
    const existingReviewer = makeSession({
      id: "app-2",
      phase: SESSION_PHASE.PLAN_REVIEW,
      subSessionInfo: {
        parentSessionId: "app-1",
        role: "architect",
        phase: SESSION_PHASE.PLAN_REVIEW,
        round: 2,
      },
    });
    const mockSessionManager = {
      list: vi.fn().mockResolvedValue([existingReviewer]),
      spawn: vi.fn().mockResolvedValue(makeSession({ id: "app-3", phase: SESSION_PHASE.PLAN_REVIEW })),
    } as unknown as SessionManager;
    const phaseManager = createPhaseManager({ config, sessionManager: mockSessionManager });
    const session = makeSession({
      phase: SESSION_PHASE.PLAN_REVIEW,
      metadata: { phase: SESSION_PHASE.PLAN_REVIEW, reviewRound: "2" },
    });

    writeMetadata(sessionsDir, session.id, {
      worktree: session.workspacePath ?? "",
      branch: session.branch ?? "",
      status: session.status,
      phase: session.phase,
      reviewRound: "2",
      project: session.projectId,
    });
    writePlanArtifact(session.workspacePath ?? "", "# Plan\n\nRound 2");

    await phaseManager.check(session);

    const spawnMock = vi.mocked(mockSessionManager.spawn);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const spawnedRoles = spawnMock.mock.calls.map((call) => call[0].subSessionInfo?.role).sort();
    expect(spawnedRoles).toEqual(["developer", "product"]);
  });

  it("respawns reviewer role when previous reviewer session is terminal", async () => {
    const exitedReviewer = makeSession({
      id: "app-2",
      status: "killed",
      activity: "exited",
      phase: SESSION_PHASE.PLAN_REVIEW,
      subSessionInfo: {
        parentSessionId: "app-1",
        role: "architect",
        phase: SESSION_PHASE.PLAN_REVIEW,
        round: 1,
      },
    });
    const mockSessionManager = {
      list: vi.fn().mockResolvedValue([exitedReviewer]),
      spawn: vi.fn().mockResolvedValue(makeSession({ id: "app-3", phase: SESSION_PHASE.PLAN_REVIEW })),
    } as unknown as SessionManager;
    const phaseManager = createPhaseManager({ config, sessionManager: mockSessionManager });
    const session = makeSession({
      phase: SESSION_PHASE.PLAN_REVIEW,
      metadata: { phase: SESSION_PHASE.PLAN_REVIEW, reviewRound: "1" },
    });

    writeMetadata(sessionsDir, session.id, {
      worktree: session.workspacePath ?? "",
      branch: session.branch ?? "",
      status: session.status,
      phase: session.phase,
      reviewRound: "1",
      project: session.projectId,
    });
    writePlanArtifact(session.workspacePath ?? "", "# Plan\n\nRound 1");

    await phaseManager.check(session);

    const spawnMock = vi.mocked(mockSessionManager.spawn);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    const roles = spawnMock.mock.calls.map((call) => call[0].subSessionInfo?.role).sort();
    expect(roles).toEqual(["architect", "developer", "product"]);
  });

  it("keeps phase on partial approvals and spawns missing reviewers only", async () => {
    const mockSessionManager = {
      list: vi.fn().mockResolvedValue([]),
      spawn: vi.fn().mockResolvedValue(makeSession({ id: "app-2", phase: SESSION_PHASE.PLAN_REVIEW })),
    } as unknown as SessionManager;
    const phaseManager = createPhaseManager({ config, sessionManager: mockSessionManager });
    const session = makeSession({
      phase: SESSION_PHASE.PLAN_REVIEW,
      metadata: { phase: SESSION_PHASE.PLAN_REVIEW, reviewRound: "1" },
    });

    writeMetadata(sessionsDir, session.id, {
      worktree: session.workspacePath ?? "",
      branch: session.branch ?? "",
      status: session.status,
      phase: session.phase,
      reviewRound: "1",
      project: session.projectId,
    });
    writePlanArtifact(session.workspacePath ?? "", "# Plan\n\nShip feature X");
    writeReviewArtifact(session.workspacePath ?? "", {
      phase: "plan_review",
      round: 1,
      role: "architect",
      decision: "approved",
      timestamp: "2026-02-23T10:35:00Z",
      content: "ok",
    });

    const phase = await phaseManager.check(session);
    expect(phase).toBe(SESSION_PHASE.PLAN_REVIEW);

    const spawnMock = vi.mocked(mockSessionManager.spawn);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const roles = spawnMock.mock.calls.map((call) => call[0].subSessionInfo?.role).sort();
    expect(roles).toEqual(["developer", "product"]);
  });

  it("spawns planning swarm when plan is missing and planningSwarm is configured", async () => {
    config.projects["my-app"] = {
      ...config.projects["my-app"]!,
      workflow: {
        mode: "full",
        planningSwarm: {
          roles: ["architect", "product"],
          maxAgents: 2,
        },
        autoCodeReview: true,
      },
    };

    const mockSessionManager = {
      list: vi.fn().mockResolvedValue([]),
      spawn: vi.fn().mockResolvedValue(makeSession({ id: "app-2", phase: SESSION_PHASE.PLANNING })),
    } as unknown as SessionManager;
    const phaseManager = createPhaseManager({ config, sessionManager: mockSessionManager });
    const session = makeSession({
      phase: SESSION_PHASE.PLANNING,
      metadata: { phase: SESSION_PHASE.PLANNING, planRound: "1" },
    });

    writeMetadata(sessionsDir, session.id, {
      worktree: session.workspacePath ?? "",
      branch: session.branch ?? "",
      status: session.status,
      phase: session.phase,
      planRound: "1",
      project: session.projectId,
    });

    await phaseManager.check(session);

    const spawnMock = vi.mocked(mockSessionManager.spawn);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[0].phase).toBe(SESSION_PHASE.PLANNING);
    const roles = spawnMock.mock.calls.map((call) => call[0].subSessionInfo?.role).sort();
    expect(roles).toEqual(["architect", "product"]);
  });

  it("respawns planning swarm role when previous planner session is terminal", async () => {
    config.projects["my-app"] = {
      ...config.projects["my-app"]!,
      workflow: {
        mode: "full",
        planningSwarm: {
          roles: ["architect", "product"],
          maxAgents: 2,
        },
        autoCodeReview: true,
      },
    };

    const exitedPlanner = makeSession({
      id: "app-2",
      status: "killed",
      activity: "exited",
      phase: SESSION_PHASE.PLANNING,
      subSessionInfo: {
        parentSessionId: "app-1",
        role: "architect",
        phase: SESSION_PHASE.PLANNING,
        round: 1,
      },
    });
    const activePlanner = makeSession({
      id: "app-3",
      phase: SESSION_PHASE.PLANNING,
      subSessionInfo: {
        parentSessionId: "app-1",
        role: "product",
        phase: SESSION_PHASE.PLANNING,
        round: 1,
      },
    });

    const mockSessionManager = {
      list: vi.fn().mockResolvedValue([exitedPlanner, activePlanner]),
      spawn: vi.fn().mockResolvedValue(makeSession({ id: "app-4", phase: SESSION_PHASE.PLANNING })),
    } as unknown as SessionManager;
    const phaseManager = createPhaseManager({ config, sessionManager: mockSessionManager });
    const session = makeSession({
      phase: SESSION_PHASE.PLANNING,
      metadata: { phase: SESSION_PHASE.PLANNING, planRound: "1" },
    });

    writeMetadata(sessionsDir, session.id, {
      worktree: session.workspacePath ?? "",
      branch: session.branch ?? "",
      status: session.status,
      phase: session.phase,
      planRound: "1",
      project: session.projectId,
    });

    await phaseManager.check(session);

    const spawnMock = vi.mocked(mockSessionManager.spawn);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[0].subSessionInfo?.role).toBe("architect");
  });

  it("keeps planning on round > 1 until plan has round marker", async () => {
    const phaseManager = createPhaseManager({ config });
    const session = makeSession({
      phase: SESSION_PHASE.PLANNING,
      metadata: { phase: SESSION_PHASE.PLANNING, planRound: "2", reviewRound: "2" },
    });

    writeMetadata(sessionsDir, session.id, {
      worktree: session.workspacePath ?? "",
      branch: session.branch ?? "",
      status: session.status,
      phase: session.phase,
      planRound: "2",
      reviewRound: "2",
      project: session.projectId,
    });
    writePlanArtifact(session.workspacePath ?? "", "# Plan\n\nNo explicit round marker");

    const phase = await phaseManager.check(session);
    expect(phase).toBe(SESSION_PHASE.PLANNING);
  });

  it("spawns implementation swarm from plan tasks when configured", async () => {
    config.projects["my-app"] = {
      ...config.projects["my-app"]!,
      workflow: {
        mode: "full",
        implementationSwarm: {
          roles: ["developer", "product", "architect"],
          maxAgents: 2,
        },
        autoCodeReview: true,
      },
    };

    const mockSessionManager = {
      list: vi.fn().mockResolvedValue([]),
      spawn: vi.fn().mockResolvedValue(makeSession({ id: "app-2", phase: SESSION_PHASE.IMPLEMENTING })),
    } as unknown as SessionManager;
    const phaseManager = createPhaseManager({ config, sessionManager: mockSessionManager });
    const session = makeSession({
      phase: SESSION_PHASE.IMPLEMENTING,
      metadata: { phase: SESSION_PHASE.IMPLEMENTING, implementationRound: "1" },
    });

    writeMetadata(sessionsDir, session.id, {
      worktree: session.workspacePath ?? "",
      branch: session.branch ?? "",
      status: session.status,
      phase: session.phase,
      implementationRound: "1",
      project: session.projectId,
    });
    writePlanArtifact(
      session.workspacePath ?? "",
      "# Plan\n\n- Build API endpoint\n- Add unit tests\n- Update docs",
    );

    await phaseManager.check(session);

    const spawnMock = vi.mocked(mockSessionManager.spawn);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[0].phase).toBe(SESSION_PHASE.IMPLEMENTING);
    const prompt = spawnMock.mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toContain("Assigned work item");
  });

  it("respawns implementation swarm role when previous implementer session is terminal", async () => {
    config.projects["my-app"] = {
      ...config.projects["my-app"]!,
      workflow: {
        mode: "full",
        implementationSwarm: {
          roles: ["developer", "product"],
          maxAgents: 2,
        },
        autoCodeReview: true,
      },
    };

    const exitedImplementer = makeSession({
      id: "app-2",
      status: "killed",
      activity: "exited",
      phase: SESSION_PHASE.IMPLEMENTING,
      subSessionInfo: {
        parentSessionId: "app-1",
        role: "developer",
        phase: SESSION_PHASE.IMPLEMENTING,
        round: 1,
      },
    });
    const activeImplementer = makeSession({
      id: "app-3",
      phase: SESSION_PHASE.IMPLEMENTING,
      subSessionInfo: {
        parentSessionId: "app-1",
        role: "product",
        phase: SESSION_PHASE.IMPLEMENTING,
        round: 1,
      },
    });

    const mockSessionManager = {
      list: vi.fn().mockResolvedValue([exitedImplementer, activeImplementer]),
      spawn: vi.fn().mockResolvedValue(makeSession({ id: "app-4", phase: SESSION_PHASE.IMPLEMENTING })),
    } as unknown as SessionManager;
    const phaseManager = createPhaseManager({ config, sessionManager: mockSessionManager });
    const session = makeSession({
      phase: SESSION_PHASE.IMPLEMENTING,
      metadata: { phase: SESSION_PHASE.IMPLEMENTING, implementationRound: "1" },
    });

    writeMetadata(sessionsDir, session.id, {
      worktree: session.workspacePath ?? "",
      branch: session.branch ?? "",
      status: session.status,
      phase: session.phase,
      implementationRound: "1",
      project: session.projectId,
    });
    writePlanArtifact(session.workspacePath ?? "", "# Plan\n\n- Implement API");

    await phaseManager.check(session);

    const spawnMock = vi.mocked(mockSessionManager.spawn);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[0].subSessionInfo?.role).toBe("developer");
  });

  it("transitions implementing to code_review when PR reaches review phase", async () => {
    const phaseManager = createPhaseManager({ config });
    const session = makeSession({
      phase: SESSION_PHASE.IMPLEMENTING,
      status: "review_pending",
      pr: {
        number: 42,
        url: "https://github.com/org/repo/pull/42",
        title: "Work",
        owner: "org",
        repo: "repo",
        branch: "feat/test",
        baseBranch: "main",
        isDraft: false,
      },
      metadata: { phase: SESSION_PHASE.IMPLEMENTING, implementationRound: "1" },
    });

    writeMetadata(sessionsDir, session.id, {
      worktree: session.workspacePath ?? "",
      branch: session.branch ?? "",
      status: session.status,
      phase: session.phase,
      implementationRound: "1",
      project: session.projectId,
    });

    const phase = await phaseManager.check(session);
    expect(phase).toBe(SESSION_PHASE.CODE_REVIEW);
    expect(readMetadataRaw(sessionsDir, session.id)?.["codeReviewRound"]).toBe("1");
  });

  it("spawns code-review sub-sessions when no code-review artifacts exist", async () => {
    const mockSessionManager = {
      list: vi.fn().mockResolvedValue([]),
      spawn: vi.fn().mockResolvedValue(makeSession({ id: "app-2", phase: SESSION_PHASE.CODE_REVIEW })),
    } as unknown as SessionManager;
    const phaseManager = createPhaseManager({ config, sessionManager: mockSessionManager });
    const session = makeSession({
      phase: SESSION_PHASE.CODE_REVIEW,
      pr: {
        number: 42,
        url: "https://github.com/org/repo/pull/42",
        title: "Work",
        owner: "org",
        repo: "repo",
        branch: "feat/test",
        baseBranch: "main",
        isDraft: false,
      },
      metadata: { phase: SESSION_PHASE.CODE_REVIEW, codeReviewRound: "1" },
    });

    writeMetadata(sessionsDir, session.id, {
      worktree: session.workspacePath ?? "",
      branch: session.branch ?? "",
      status: session.status,
      phase: session.phase,
      codeReviewRound: "1",
      project: session.projectId,
    });
    writePlanArtifact(session.workspacePath ?? "", "# Plan\n\nShip");

    await phaseManager.check(session);

    const spawnMock = vi.mocked(mockSessionManager.spawn);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    const roles = spawnMock.mock.calls.map((call) => call[0].subSessionInfo?.role).sort();
    expect(roles).toEqual(["architect", "developer", "product"]);
  });

  it("transitions code_review to ready_to_merge when all reviewers approved", async () => {
    const phaseManager = createPhaseManager({ config });
    const session = makeSession({
      phase: SESSION_PHASE.CODE_REVIEW,
      metadata: { phase: SESSION_PHASE.CODE_REVIEW, codeReviewRound: "1" },
    });

    writeMetadata(sessionsDir, session.id, {
      worktree: session.workspacePath ?? "",
      branch: session.branch ?? "",
      status: session.status,
      phase: session.phase,
      codeReviewRound: "1",
      project: session.projectId,
    });

    writeReviewArtifact(session.workspacePath ?? "", {
      phase: "code_review",
      round: 1,
      role: "architect",
      decision: "approved",
      timestamp: "2026-02-23T10:40:00Z",
      content: "ok",
    });
    writeReviewArtifact(session.workspacePath ?? "", {
      phase: "code_review",
      round: 1,
      role: "developer",
      decision: "approved",
      timestamp: "2026-02-23T10:41:00Z",
      content: "ok",
    });
    writeReviewArtifact(session.workspacePath ?? "", {
      phase: "code_review",
      round: 1,
      role: "product",
      decision: "approved",
      timestamp: "2026-02-23T10:42:00Z",
      content: "ok",
    });

    const phase = await phaseManager.check(session);
    expect(phase).toBe(SESSION_PHASE.READY_TO_MERGE);
  });

  it("transitions code_review back to implementing when changes are requested", async () => {
    const phaseManager = createPhaseManager({ config });
    const session = makeSession({
      phase: SESSION_PHASE.CODE_REVIEW,
      metadata: {
        phase: SESSION_PHASE.CODE_REVIEW,
        codeReviewRound: "2",
        implementationRound: "1",
      },
    });

    writeMetadata(sessionsDir, session.id, {
      worktree: session.workspacePath ?? "",
      branch: session.branch ?? "",
      status: session.status,
      phase: session.phase,
      codeReviewRound: "2",
      implementationRound: "1",
      project: session.projectId,
    });

    writeReviewArtifact(session.workspacePath ?? "", {
      phase: "code_review",
      round: 2,
      role: "architect",
      decision: "changes_requested",
      timestamp: "2026-02-23T10:45:00Z",
      content: "fix issues",
    });

    const phase = await phaseManager.check(session);
    expect(phase).toBe(SESSION_PHASE.IMPLEMENTING);

    const raw = readMetadataRaw(sessionsDir, session.id);
    expect(raw?.["codeReviewRound"]).toBe("3");
    expect(raw?.["implementationRound"]).toBe("2");
  });
});
