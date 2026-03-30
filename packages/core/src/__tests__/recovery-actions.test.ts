import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { readMetadataRaw } from "../metadata.js";
import { getSessionsDir } from "../paths.js";
import { cleanupSession, escalateSession, executeAction, recoverSession } from "../recovery/actions.js";
import { runRecovery } from "../recovery/manager.js";
import { getRecoveryLogPath, scanAllSessions } from "../recovery/scanner.js";
import {
  DEFAULT_RECOVERY_CONFIG,
  type RecoveryAssessment,
  type RecoveryContext,
} from "../recovery/types.js";
import type { OrchestratorConfig, PluginRegistry, Runtime, Workspace } from "../types.js";

function makeConfig(rootDir: string): OrchestratorConfig {
  return {
    configPath: join(rootDir, "agent-orchestrator.yaml"),
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: {
      app: {
        name: "app",
        repo: "org/repo",
        path: join(rootDir, "project"),
        defaultBranch: "main",
        sessionPrefix: "app",
      },
    },
    notifiers: {},
    notificationRouting: {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: ["desktop"],
      info: ["desktop"],
    },
    reactions: {},
  };
}

function makeRegistry(): PluginRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn().mockResolvedValue(undefined),
    loadFromConfig: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAssessment(overrides: Partial<RecoveryAssessment> = {}): RecoveryAssessment {
  return {
    sessionId: "app-1",
    projectId: "app",
    classification: "live",
    action: "recover",
    reason: "Session is running normally",
    runtimeAlive: true,
    runtimeHandle: { id: "rt-1", runtimeName: "tmux", data: {} },
    workspaceExists: true,
    workspacePath: "/tmp/worktree",
    agentProcessRunning: true,
    agentActivity: "active",
    metadataValid: true,
    metadataStatus: "working",
    rawMetadata: {
      project: "app",
      branch: "feat/test",
      issue: "123",
      pr: "https://github.com/org/repo/pull/42",
      createdAt: "2025-01-01T00:00:00.000Z",
      status: "working",
      summary: "Recovered summary",
    },
    ...overrides,
  };
}

function makeContext(rootDir: string, overrides: Partial<RecoveryContext> = {}): RecoveryContext {
  return {
    configPath: join(rootDir, "agent-orchestrator.yaml"),
    recoveryConfig: {
      ...DEFAULT_RECOVERY_CONFIG,
      logPath: join(rootDir, "recovery.log"),
    },
    dryRun: false,
    ...overrides,
  };
}

describe("recoverSession", () => {
  let rootDir: string;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("persists restoredAt and returns a session with restoredAt", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment();
    const context = makeContext(rootDir);

    const result = await recoverSession(assessment, config, registry, context);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    const metadata = readMetadataRaw(sessionsDir, assessment.sessionId);

    expect(result.success).toBe(true);
    expect(result.session?.restoredAt).toBeInstanceOf(Date);
    expect(metadata?.["restoredAt"]).toBeDefined();
    expect(metadata?.["recoveredAt"]).toBeUndefined();
  });

  it("preserves project ownership when legacy metadata omits the project field", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      rawMetadata: {
        branch: "feature/recover",
        worktree: join(rootDir, "project"),
        status: "needs_input",
      },
    });
    const context = makeContext(rootDir);

    const result = await recoverSession(assessment, config, registry, context);

    expect(result.success).toBe(true);
    expect(result.session?.projectId).toBe("app");
  });

  it("returns the max-attempt reason when recovery escalates", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      rawMetadata: {
        ...makeAssessment().rawMetadata,
        recoveryCount: "3",
      },
    });
    const context = makeContext(rootDir, {
      recoveryConfig: {
        ...DEFAULT_RECOVERY_CONFIG,
        logPath: join(rootDir, "recovery.log"),
        maxRecoveryAttempts: 3,
      },
    });

    const result = await recoverSession(assessment, config, registry, context);

    expect(result.success).toBe(true);
    expect(result.action).toBe("escalate");
    expect(result.reason).toBe("Exceeded max recovery attempts (3)");
  });

  it("dry-run recovery reports escalate when attempts exceed limit", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      rawMetadata: {
        ...makeAssessment().rawMetadata,
        recoveryCount: "3",
      },
    });
    const context = makeContext(rootDir, {
      dryRun: true,
      recoveryConfig: {
        ...DEFAULT_RECOVERY_CONFIG,
        logPath: join(rootDir, "recovery.log"),
        maxRecoveryAttempts: 3,
      },
    });

    const result = await recoverSession(assessment, config, registry, context);

    expect(result.success).toBe(true);
    expect(result.action).toBe("escalate");
    expect(result.requiresManualIntervention).toBe(true);
    expect(result.reason).toBe("Exceeded max recovery attempts (3)");
  });
});

describe("escalateSession", () => {
  let rootDir: string;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("uses the assessment reason during dry runs", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      action: "escalate",
      classification: "partial",
      reason: "Workspace exists but runtime is missing",
    });
    const context = makeContext(rootDir, { dryRun: true });

    const result = await escalateSession(assessment, config, registry, context);

    expect(result.success).toBe(true);
    expect(result.action).toBe("escalate");
    expect(result.reason).toBe("Workspace exists but runtime is missing");
  });
});

describe("recovery manager and scanner", () => {
  let rootDir: string;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("respects custom recovery logPath in manager options", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "app-1"),
      "project=app\nstatus=terminated\nworktree=/tmp/worktree\n",
      "utf-8",
    );

    const customLogPath = join(rootDir, "custom-recovery.log");
    const registry = makeRegistry();

    await runRecovery({
      config,
      registry,
      recoveryConfig: {
        ...DEFAULT_RECOVERY_CONFIG,
        logPath: customLogPath,
      },
    });

    expect(existsSync(customLogPath)).toBe(true);
    expect(readFileSync(customLogPath, "utf-8")).toContain('"sessionId":"app-1"');

    const defaultLogPath = getRecoveryLogPath(config.configPath);
    expect(defaultLogPath).not.toBe(customLogPath);
  });

  it("scans sessions using metadata listing rules", () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });

    writeFileSync(join(sessionsDir, "app-1"), "project=app\nstatus=working\n", "utf-8");
    writeFileSync(join(sessionsDir, ".tmp"), "project=app\n", "utf-8");
    writeFileSync(join(sessionsDir, "bad.session"), "project=app\n", "utf-8");

    const scanned = scanAllSessions(config);

    expect(scanned).toHaveLength(1);
    expect(scanned[0]?.sessionId).toBe("app-1");
  });
});

describe("recoverSession - error handling", () => {
  let rootDir: string;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("returns success:false when updateMetadata throws (invalid session ID)", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    // Use an invalid session ID with special chars to make validateSessionId throw
    const assessment = makeAssessment({
      sessionId: "app/../invalid",
    });
    const context = makeContext(rootDir);

    const result = await recoverSession(assessment, config, registry, context);

    expect(result.success).toBe(false);
    expect(result.action).toBe("recover");
    expect(result.error).toBeDefined();
  });

  it("dryRun returns success without modifying metadata", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment();
    const context = makeContext(rootDir, { dryRun: true });

    const result = await recoverSession(assessment, config, registry, context);

    expect(result.success).toBe(true);
    expect(result.action).toBe("recover");
    // In dry run, no session is created
    expect(result.session).toBeUndefined();
  });

  it("increments recoveryCount from rawMetadata", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      rawMetadata: {
        ...makeAssessment().rawMetadata,
        recoveryCount: "1",
      },
    });
    const context = makeContext(rootDir);

    const result = await recoverSession(assessment, config, registry, context);

    expect(result.success).toBe(true);
    expect(result.action).toBe("recover");

    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    const metadata = readMetadataRaw(sessionsDir, "app-1");
    expect(metadata?.["recoveryCount"]).toBe("2");
  });
});

describe("cleanupSession", () => {
  let rootDir: string;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("returns success in dry-run mode without performing cleanup", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      action: "cleanup",
      classification: "dead",
      runtimeAlive: false,
      workspaceExists: false,
    });
    const context = makeContext(rootDir, { dryRun: true });

    const result = await cleanupSession(assessment, config, registry, context);

    expect(result.success).toBe(true);
    expect(result.action).toBe("cleanup");
  });

  it("destroys runtime when runtimeAlive and handle present", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const mockRuntime: Runtime = {
      name: "tmux",
      create: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn(),
      getOutput: vi.fn(),
      isAlive: vi.fn(),
    };
    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn(),
      loadFromConfig: vi.fn(),
    };

    const assessment = makeAssessment({
      action: "cleanup",
      classification: "dead",
      runtimeAlive: true,
      runtimeHandle: { id: "rt-1", runtimeName: "tmux", data: {} },
      workspaceExists: false,
    });

    // Create sessions dir with metadata for the session
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "app-1"), "project=app\nstatus=working\n", "utf-8");

    const context = makeContext(rootDir);
    const result = await cleanupSession(assessment, config, registry, context);

    expect(result.success).toBe(true);
    expect(result.action).toBe("cleanup");
    expect(mockRuntime.destroy).toHaveBeenCalledWith({ id: "rt-1", runtimeName: "tmux", data: {} });
  });

  it("destroys workspace when workspaceExists and workspace plugin available", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const mockWorkspace: Workspace = {
      name: "worktree",
      create: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
      list: vi.fn(),
    };
    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn(),
      loadFromConfig: vi.fn(),
    };

    const assessment = makeAssessment({
      action: "cleanup",
      classification: "dead",
      runtimeAlive: false,
      workspaceExists: true,
      rawMetadata: {
        ...makeAssessment().rawMetadata,
        worktree: "/tmp/workspace-path",
      },
    });

    // Create sessions dir with metadata
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "app-1"), "project=app\nstatus=working\n", "utf-8");

    const context = makeContext(rootDir);
    const result = await cleanupSession(assessment, config, registry, context);

    expect(result.success).toBe(true);
    expect(mockWorkspace.destroy).toHaveBeenCalledWith("/tmp/workspace-path");
  });

  it("ignores errors from runtime.destroy during cleanup", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const mockRuntime: Runtime = {
      name: "tmux",
      create: vi.fn(),
      destroy: vi.fn().mockRejectedValue(new Error("destroy failed")),
      sendMessage: vi.fn(),
      getOutput: vi.fn(),
      isAlive: vi.fn(),
    };
    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn(),
      loadFromConfig: vi.fn(),
    };

    const assessment = makeAssessment({
      action: "cleanup",
      runtimeAlive: true,
      runtimeHandle: { id: "rt-1", runtimeName: "tmux", data: {} },
      workspaceExists: false,
    });

    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "app-1"), "project=app\nstatus=working\n", "utf-8");

    const context = makeContext(rootDir);
    const result = await cleanupSession(assessment, config, registry, context);

    // Should succeed even though runtime.destroy threw
    expect(result.success).toBe(true);
    expect(result.action).toBe("cleanup");
  });

  it("returns failure when metadata update throws (invalid session ID)", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    // Invalid session ID triggers validateSessionId error inside updateMetadata
    const assessment = makeAssessment({
      sessionId: "app/../bad",
      action: "cleanup",
      runtimeAlive: false,
      workspaceExists: false,
    });
    const context = makeContext(rootDir);

    const result = await cleanupSession(assessment, config, registry, context);

    expect(result.success).toBe(false);
    expect(result.action).toBe("cleanup");
    expect(result.error).toBeDefined();
  });
});

describe("escalateSession - additional", () => {
  let rootDir: string;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("updates metadata with escalation info on non-dry run", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      action: "escalate",
      classification: "partial",
      reason: "Incomplete state",
    });

    // Create sessions dir with metadata
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "app-1"), "project=app\nstatus=working\n", "utf-8");

    const context = makeContext(rootDir);
    const result = await escalateSession(assessment, config, registry, context);

    expect(result.success).toBe(true);
    expect(result.action).toBe("escalate");
    expect(result.requiresManualIntervention).toBe(true);
    expect(result.reason).toBe("Incomplete state");

    const metadata = readMetadataRaw(sessionsDir, "app-1");
    expect(metadata?.["status"]).toBe("stuck");
    expect(metadata?.["escalationReason"]).toBe("Incomplete state");
    expect(metadata?.["escalatedAt"]).toBeDefined();
  });

  it("returns failure when metadata update fails (invalid session ID)", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    // Invalid session ID triggers error inside updateMetadata
    const assessment = makeAssessment({
      sessionId: "app/../bad",
      action: "escalate",
      reason: "Runtime missing",
    });
    const context = makeContext(rootDir);

    const result = await escalateSession(assessment, config, registry, context);

    expect(result.success).toBe(false);
    expect(result.action).toBe("escalate");
    expect(result.error).toBeDefined();
    expect(result.requiresManualIntervention).toBe(true);
  });
});

describe("executeAction", () => {
  let rootDir: string;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("routes to recoverSession for action=recover", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({ action: "recover" });
    const context = makeContext(rootDir);

    const result = await executeAction(assessment, config, registry, context);

    expect(result.action).toBe("recover");
    expect(result.success).toBe(true);
  });

  it("routes to cleanupSession for action=cleanup", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      action: "cleanup",
      runtimeAlive: false,
      workspaceExists: false,
    });

    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "app-1"), "project=app\nstatus=working\n", "utf-8");

    const context = makeContext(rootDir);
    const result = await executeAction(assessment, config, registry, context);

    expect(result.action).toBe("cleanup");
    expect(result.success).toBe(true);
  });

  it("routes to escalateSession for action=escalate", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      action: "escalate",
      reason: "Partial state",
    });

    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "app-1"), "project=app\nstatus=working\n", "utf-8");

    const context = makeContext(rootDir);
    const result = await executeAction(assessment, config, registry, context);

    expect(result.action).toBe("escalate");
    expect(result.success).toBe(true);
    expect(result.requiresManualIntervention).toBe(true);
  });

  it("returns skip result for action=skip", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      action: "skip",
      classification: "unrecoverable",
    });
    const context = makeContext(rootDir);

    const result = await executeAction(assessment, config, registry, context);

    expect(result.action).toBe("skip");
    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("app-1");
  });

  it("returns skip for unknown action values (default case)", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    // Force an unknown action by casting
    const assessment = makeAssessment({
      action: "unknown" as RecoveryAssessment["action"],
    });
    const context = makeContext(rootDir);

    const result = await executeAction(assessment, config, registry, context);

    expect(result.action).toBe("skip");
    expect(result.success).toBe(true);
  });
});
