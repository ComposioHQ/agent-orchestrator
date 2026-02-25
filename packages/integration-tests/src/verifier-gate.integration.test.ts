import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  createLifecycleManager,
  writeMetadata,
  updateMetadata,
  readMetadataRaw,
  getSessionsDir,
  type Session,
  type SessionManager,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type OrchestratorConfig,
} from "@composio/ao-core";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "working",
    activity: "active",
    branch: "feat/issue-11",
    issueId: "11",
    pr: null,
    workspacePath: "/tmp/ws",
    runtimeHandle: { id: "rt-1", runtimeName: "mock", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function writeCompleteEvidence(workspacePath: string, sessionId: string): string {
  const evidenceDir = join(workspacePath, ".ao", "evidence", sessionId);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    join(evidenceDir, "command-log.json"),
    JSON.stringify({
      schemaVersion: "1",
      complete: true,
      entries: [{ command: "pnpm test", exitCode: 0 }],
    }),
  );
  writeFileSync(
    join(evidenceDir, "tests-run.json"),
    JSON.stringify({
      schemaVersion: "1",
      complete: true,
      tests: [{ command: "pnpm test", status: "passed" }],
    }),
  );
  writeFileSync(
    join(evidenceDir, "changed-paths.json"),
    JSON.stringify({
      schemaVersion: "1",
      complete: true,
      paths: ["packages/core/src/lifecycle-manager.ts"],
    }),
  );
  writeFileSync(
    join(evidenceDir, "known-risks.json"),
    JSON.stringify({
      schemaVersion: "1",
      complete: true,
      risks: [{ risk: "none" }],
    }),
  );
  return evidenceDir;
}

describe("verifier gate loop (integration)", () => {
  let tmpDir: string;
  let configPath: string;
  let sessionsDir: string;
  let config: OrchestratorConfig;
  let sessions: Map<string, Session>;
  let sendMock = vi.fn();
  let spawnMock = vi.fn();

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ao-verifier-gate-${randomUUID()}`);
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
        verifier: { runtime: "mock", agent: "mock-agent" },
      },
      projects: {
        "my-app": {
          name: "My App",
          repo: "org/my-app",
          path: join(tmpDir, "repo"),
          defaultBranch: "main",
          sessionPrefix: "app",
          verifier: { runtime: "mock", agent: "mock-agent" },
        },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
      readyThresholdMs: 300_000,
    };

    sessionsDir = getSessionsDir(configPath, config.projects["my-app"].path);
    mkdirSync(sessionsDir, { recursive: true });
    sessions = new Map<string, Session>();
    sendMock = vi.fn().mockResolvedValue(undefined);
    spawnMock = vi.fn();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("covers verifier fail/pass loop with worker feedback", async () => {
    const workspacePath = join(tmpDir, "ws");
    const evidenceDir = writeCompleteEvidence(workspacePath, "app-1");
    const worker = makeSession({
      workspacePath,
      metadata: {
        evidenceSchemaVersion: "1",
        evidenceDir,
        evidenceCommandLog: join(evidenceDir, "command-log.json"),
        evidenceTestsRun: join(evidenceDir, "tests-run.json"),
        evidenceChangedPaths: join(evidenceDir, "changed-paths.json"),
        evidenceKnownRisks: join(evidenceDir, "known-risks.json"),
      },
    });
    sessions.set(worker.id, worker);

    writeMetadata(sessionsDir, worker.id, {
      worktree: workspacePath,
      branch: worker.branch ?? "feat/issue-11",
      status: "working",
      project: worker.projectId,
      issue: worker.issueId ?? undefined,
      evidenceSchemaVersion: "1",
      evidenceDir,
      evidenceCommandLog: join(evidenceDir, "command-log.json"),
      evidenceTestsRun: join(evidenceDir, "tests-run.json"),
      evidenceChangedPaths: join(evidenceDir, "changed-paths.json"),
      evidenceKnownRisks: join(evidenceDir, "known-risks.json"),
    });

    let verifierCount = 1;
    spawnMock.mockImplementation(async () => {
      const verifierId = `app-${verifierCount + 1}`;
      verifierCount += 1;
      const verifier = makeSession({
        id: verifierId,
        status: "spawning",
        workspacePath,
        metadata: { role: "verifier", verifierFor: "app-1" },
      });
      sessions.set(verifierId, verifier);
      return verifier;
    });

    const runtime: Runtime = {
      name: "mock",
      create: vi.fn(),
      destroy: vi.fn(),
      sendMessage: vi.fn(),
      getOutput: vi.fn().mockResolvedValue("$ prompt"),
      isAlive: vi.fn().mockResolvedValue(true),
    };
    const agent: Agent = {
      name: "mock-agent",
      processName: "mock-agent",
      getLaunchCommand: vi.fn(),
      getEnvironment: vi.fn(),
      detectActivity: vi.fn().mockReturnValue("active"),
      getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
      isProcessRunning: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockResolvedValue(null),
    };
    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return runtime;
        if (slot === "agent") return agent;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn(),
      loadFromConfig: vi.fn(),
    };
    const sessionManager: SessionManager = {
      spawn: spawnMock,
      spawnOrchestrator: vi.fn(),
      restore: vi.fn(),
      list: vi.fn().mockResolvedValue([...sessions.values()]),
      get: vi.fn().mockImplementation(async (id: string) => {
        const session = sessions.get(id) ?? null;
        if (!session) return null;
        const raw = readMetadataRaw(sessionsDir, id);
        if (raw) {
          session.metadata = { ...raw };
          session.status = (raw["status"] as Session["status"] | undefined) ?? session.status;
          session.workspacePath = raw["worktree"] ?? session.workspacePath;
          session.branch = raw["branch"] ?? session.branch;
        }
        return session;
      }),
      kill: vi.fn(),
      cleanup: vi.fn(),
      send: sendMock,
    };

    const lm = createLifecycleManager({ config, registry, sessionManager });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("verifier_pending");
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const firstVerifier = sessions.get("app-2");
    expect(firstVerifier).toBeDefined();
    firstVerifier!.status = "done";
    updateMetadata(sessionsDir, "app-2", {
      verifierVerdict: "failed",
      verifierFeedback: "Fix verifier-reported gaps and rerun tests.",
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("verifier_failed");
    expect(sendMock).toHaveBeenCalledWith("app-1", expect.stringContaining("Fix verifier-reported"));

    // Simulate worker updates by changing evidence files, which unlocks re-verification.
    writeFileSync(
      join(evidenceDir, "command-log.json"),
      JSON.stringify({
        schemaVersion: "1",
        complete: true,
        entries: [{ command: "pnpm test --rerun", exitCode: 0 }],
      }),
    );

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("verifier_pending");
    expect(spawnMock).toHaveBeenCalledTimes(2);

    const secondVerifier = sessions.get("app-3");
    expect(secondVerifier).toBeDefined();
    secondVerifier!.status = "done";
    updateMetadata(sessionsDir, "app-3", { verifierVerdict: "passed" });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("pr_ready");

    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta!["verifierStatus"]).toBe("passed");
  });
});
