import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createSessionManager } from "../session-manager.js";
import {
  createImprovementService,
  type ImprovementLinkage,
  type NormalizedFeedbackReport,
} from "../improvement.js";
import { getSessionsDir } from "../paths.js";
import type {
  Agent,
  OrchestratorConfig,
  PluginRegistry,
  Runtime,
  RuntimeHandle,
  Tracker,
  Workspace,
} from "../types.js";

interface TestReport extends Omit<NormalizedFeedbackReport, "linkage"> {
  linkage?: Partial<ImprovementLinkage>;
}

function makeHandle(id: string): RuntimeHandle {
  return { id, runtimeName: "mock-runtime", data: {} };
}

describe("improvement.spawn integration", () => {
  let tmpDir: string;
  let configPath: string;
  let sessionsDir: string;
  let config: OrchestratorConfig;
  let runtime: Runtime;
  let agent: Agent;
  let workspace: Workspace;
  let tracker: Tracker;
  let registry: PluginRegistry;
  let reports: Map<string, TestReport>;
  let createdIssueCount: number;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ao-improvement-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "projects: {}\n");

    config = {
      configPath,
      defaults: {
        runtime: "mock-runtime",
        agent: "mock-agent",
        workspace: "mock-workspace",
        notifiers: [],
      },
      projects: {
        app: {
          name: "app",
          repo: "acme/upstream-repo",
          path: join(tmpDir, "repo"),
          defaultBranch: "main",
          sessionPrefix: "app",
          tracker: { plugin: "github" },
        },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
      readyThresholdMs: 300_000,
    };

    sessionsDir = getSessionsDir(configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });

    runtime = {
      name: "mock-runtime",
      create: vi.fn().mockResolvedValue(makeHandle("rt-1")),
      destroy: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getOutput: vi.fn().mockResolvedValue(""),
      isAlive: vi.fn().mockResolvedValue(true),
    };

    agent = {
      name: "mock-agent",
      processName: "mock-agent",
      getLaunchCommand: vi.fn().mockReturnValue("mock-agent"),
      getEnvironment: vi.fn().mockReturnValue({}),
      detectActivity: vi.fn().mockReturnValue("active"),
      getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
      isProcessRunning: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockResolvedValue(null),
    };

    workspace = {
      name: "mock-workspace",
      create: vi.fn().mockResolvedValue({
        path: join(tmpDir, "worktrees", "app-1"),
        branch: "feat/issue-101",
        sessionId: "app-1",
        projectId: "app",
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    };

    createdIssueCount = 0;
    tracker = {
      name: "github",
      getIssue: vi.fn().mockImplementation(async (id: string) => ({
        id,
        title: `Issue ${id}`,
        description: "Issue body",
        url: `https://github.com/acme/fork-repo/issues/${id}`,
        state: "open",
        labels: [],
      })),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockImplementation((id: string, project) => {
        return `https://github.com/${project.repo}/issues/${String(id).replace(/^#/, "")}`;
      }),
      issueLabel: vi.fn().mockReturnValue("#101"),
      branchName: vi.fn().mockImplementation((id: string) => `feat/issue-${id.replace(/^#/, "")}`),
      generatePrompt: vi.fn().mockResolvedValue("tracker prompt"),
      createIssue: vi.fn().mockImplementation(async (_input, project) => {
        createdIssueCount += 1;
        return {
          id: "101",
          title: "Improve pipeline",
          description: "created issue",
          url: `https://github.com/${project.repo}/issues/101`,
          state: "open",
          labels: [],
        };
      }),
    };

    registry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return runtime;
        if (slot === "agent") return agent;
        if (slot === "workspace") return workspace;
        if (slot === "tracker") return tracker;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };

    reports = new Map<string, TestReport>([
      [
        "r-1",
        {
          id: "r-1",
          projectId: "app",
          kind: "improvement_suggestion",
          title: "Improve spawn reliability",
          body: "Pipeline occasionally drops metadata links.",
          evidence: "Observed in session app-77",
          sourceSessionId: "app-77",
          confidence: 0.9,
          severity: "warning",
          labels: ["self-improvement"],
        },
      ],
    ]);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  const makeReportsAdapter = () => ({
    getReport: vi.fn(async (reportId: string) => reports.get(reportId) ?? null),
    normalize: vi.fn((report: TestReport) => report),
    updateLinkage: vi.fn(async (reportId: string, patch: Partial<ImprovementLinkage>) => {
      const current = reports.get(reportId);
      if (!current) throw new Error(`missing report ${reportId}`);
      reports.set(reportId, {
        ...current,
        linkage: {
          ...(current.linkage ?? {}),
          ...patch,
        },
      });
    }),
  });

  it("links report -> issue -> session with metadata and fork-mode target", async () => {
    const reportAdapter = makeReportsAdapter();
    const sessionManager = createSessionManager({ config, registry });
    const service = createImprovementService({
      config,
      registry,
      sessionManager,
      reports: reportAdapter,
      forkMode: {
        resolveIssueTarget: vi.fn().mockResolvedValue({
          repo: "acme/fork-repo",
          mode: "fork-first",
        }),
      },
      guardrails: { minConfidence: 0.5, minSeverity: "info" },
    });

    const result = await service.spawn("r-1");

    expect(result.reportId).toBe("r-1");
    expect(result.issue.id).toBe("101");
    expect(result.session.id).toBe("app-1");
    expect(result.issueTarget).toEqual({ repo: "acme/fork-repo", mode: "fork-first" });

    expect(tracker.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Improve spawn reliability" }),
      expect.objectContaining({ repo: "acme/fork-repo" }),
    );

    const rawMeta = readFileSync(join(sessionsDir, "app-1"), "utf-8");
    expect(rawMeta).toContain("improvementReportId=r-1");
    expect(rawMeta).toContain("improvementIssueId=101");
    expect(rawMeta).toContain("improvementIssueRepo=acme/fork-repo");
    expect(rawMeta).toContain("improvementIssueMode=fork-first");

    const linkedReport = reports.get("r-1");
    expect(linkedReport?.linkage?.issueId).toBe("101");
    expect(linkedReport?.linkage?.sessionId).toBe("app-1");
    expect(linkedReport?.linkage?.issueRepo).toBe("acme/fork-repo");
  });

  it("is idempotent for repeat spawn(reportId) calls", async () => {
    const reportAdapter = makeReportsAdapter();
    const sessionManager = createSessionManager({ config, registry });
    const service = createImprovementService({
      config,
      registry,
      sessionManager,
      reports: reportAdapter,
      guardrails: { minConfidence: 0.5, minSeverity: "info" },
    });

    const first = await service.spawn("r-1");
    const second = await service.spawn("r-1");

    expect(first.session.id).toBe("app-1");
    expect(second.session.id).toBe("app-1");
    expect(second.idempotentReuse).toBe(true);
    expect(createdIssueCount).toBe(1);
    expect(runtime.create).toHaveBeenCalledTimes(1);
  });

  it("records failure state when guardrails block spawning", async () => {
    reports.set("r-2", {
      id: "r-2",
      projectId: "app",
      kind: "bug_report",
      title: "Low confidence report",
      body: "Potential issue",
      evidence: "none",
      sourceSessionId: "app-2",
      confidence: 0.2,
      severity: "info",
    });
    const reportAdapter = makeReportsAdapter();
    const sessionManager = createSessionManager({ config, registry });
    const service = createImprovementService({
      config,
      registry,
      sessionManager,
      reports: reportAdapter,
      guardrails: { minConfidence: 0.8, minSeverity: "warning" },
    });

    await expect(service.spawn("r-2")).rejects.toThrow("below threshold");
    expect(createdIssueCount).toBe(0);
    expect(reports.get("r-2")?.linkage?.lastError).toContain("below threshold");
  });

  it("persists issue linkage when spawn fails after issue creation", async () => {
    runtime.create = vi.fn().mockRejectedValue(new Error("runtime unavailable"));
    const reportAdapter = makeReportsAdapter();
    const sessionManager = createSessionManager({ config, registry });
    const service = createImprovementService({
      config,
      registry,
      sessionManager,
      reports: reportAdapter,
    });

    await expect(service.spawn("r-1")).rejects.toThrow("runtime unavailable");
    expect(createdIssueCount).toBe(1);
    expect(reports.get("r-1")?.linkage?.issueId).toBe("101");
    expect(reports.get("r-1")?.linkage?.sessionId).toBeUndefined();
    expect(reports.get("r-1")?.linkage?.lastError).toContain("runtime unavailable");
  });
});
