import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  initGnapDir,
  isGnapInitialized,
  getGnapDir,
  writeGnapTask,
  readGnapTask,
  updateGnapTask,
  listGnapTasks,
  readGnapAgents,
  writeGnapAgent,
  writeGnapRun,
  readGnapRun,
  updateGnapRun,
  writeGnapMessage,
  sessionStatusToGnapState,
  gnapTaskStateToRunState,
  generateGnapTaskId,
  syncSessionToGnap,
  syncDecompositionToGnap,
  type GnapTask,
  type GnapAgent,
  type GnapRun,
  type GnapMessage,
} from "../gnap.js";

let projectPath: string;

beforeEach(() => {
  projectPath = join(tmpdir(), `ao-test-gnap-${randomUUID()}`);
  mkdirSync(projectPath, { recursive: true });
});

afterEach(() => {
  rmSync(projectPath, { recursive: true, force: true });
});

describe("initGnapDir", () => {
  it("creates the .gnap directory structure", () => {
    initGnapDir(projectPath);

    expect(existsSync(join(projectPath, ".gnap", "version"))).toBe(true);
    expect(existsSync(join(projectPath, ".gnap", "agents.json"))).toBe(true);
    expect(existsSync(join(projectPath, ".gnap", "tasks"))).toBe(true);
    expect(existsSync(join(projectPath, ".gnap", "runs"))).toBe(true);
    expect(existsSync(join(projectPath, ".gnap", "messages"))).toBe(true);
  });

  it("writes protocol version 4", () => {
    initGnapDir(projectPath);

    const version = readFileSync(join(projectPath, ".gnap", "version"), "utf-8");
    expect(version).toBe("4");
  });

  it("initializes empty agents.json", () => {
    initGnapDir(projectPath);

    const agents = JSON.parse(readFileSync(join(projectPath, ".gnap", "agents.json"), "utf-8"));
    expect(agents).toEqual({});
  });

  it("is idempotent — safe to call multiple times", () => {
    initGnapDir(projectPath);
    initGnapDir(projectPath);

    expect(existsSync(join(projectPath, ".gnap", "version"))).toBe(true);
  });

  it("supports custom gnap directory", () => {
    initGnapDir(projectPath, ".my-gnap");

    expect(existsSync(join(projectPath, ".my-gnap", "version"))).toBe(true);
    expect(existsSync(join(projectPath, ".my-gnap", "tasks"))).toBe(true);
  });
});

describe("isGnapInitialized", () => {
  it("returns false for uninitialized project", () => {
    expect(isGnapInitialized(projectPath)).toBe(false);
  });

  it("returns true after initialization", () => {
    initGnapDir(projectPath);
    expect(isGnapInitialized(projectPath)).toBe(true);
  });
});

describe("getGnapDir", () => {
  it("returns default .gnap path", () => {
    expect(getGnapDir(projectPath)).toBe(join(projectPath, ".gnap"));
  });

  it("supports custom directory", () => {
    expect(getGnapDir(projectPath, ".custom")).toBe(join(projectPath, ".custom"));
  });
});

describe("task operations", () => {
  beforeEach(() => {
    initGnapDir(projectPath);
  });

  const sampleTask: GnapTask = {
    id: "FA-1",
    title: "Build authentication",
    desc: "Implement OAuth2 login flow",
    assigned_to: ["claude-1"],
    state: "in_progress",
    created_by: "ao-orchestrator",
    created_at: "2026-03-18T10:00:00Z",
    tags: ["auth"],
  };

  it("writes and reads a task", () => {
    writeGnapTask(projectPath, sampleTask);

    const task = readGnapTask(projectPath, "FA-1");
    expect(task).not.toBeNull();
    expect(task!.id).toBe("FA-1");
    expect(task!.title).toBe("Build authentication");
    expect(task!.state).toBe("in_progress");
    expect(task!.assigned_to).toEqual(["claude-1"]);
  });

  it("writes valid JSON to tasks directory", () => {
    writeGnapTask(projectPath, sampleTask);

    const content = readFileSync(join(projectPath, ".gnap", "tasks", "FA-1.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe("FA-1");
  });

  it("returns null for nonexistent task", () => {
    expect(readGnapTask(projectPath, "nonexistent")).toBeNull();
  });

  it("updates a task preserving existing fields", () => {
    writeGnapTask(projectPath, sampleTask);

    const updated = updateGnapTask(projectPath, "FA-1", {
      state: "review",
    });

    expect(updated).toBe(true);
    const task = readGnapTask(projectPath, "FA-1");
    expect(task!.state).toBe("review");
    expect(task!.title).toBe("Build authentication");
    expect(task!.updated_at).toBeDefined();
  });

  it("returns false when updating nonexistent task", () => {
    expect(updateGnapTask(projectPath, "nope", { state: "done" })).toBe(false);
  });

  it("lists all tasks", () => {
    writeGnapTask(projectPath, sampleTask);
    writeGnapTask(projectPath, {
      ...sampleTask,
      id: "FA-2",
      title: "Write tests",
      state: "ready",
    });

    const tasks = listGnapTasks(projectPath);
    expect(tasks).toHaveLength(2);
    const ids = tasks.map((t) => t.id).sort();
    expect(ids).toEqual(["FA-1", "FA-2"]);
  });

  it("returns empty array when no tasks exist", () => {
    expect(listGnapTasks(projectPath)).toEqual([]);
  });

  it("handles task with parent field", () => {
    writeGnapTask(projectPath, {
      ...sampleTask,
      id: "FA-1-1",
      parent: "FA-1",
    });

    const task = readGnapTask(projectPath, "FA-1-1");
    expect(task!.parent).toBe("FA-1");
  });

  it("handles blocked tasks", () => {
    writeGnapTask(projectPath, {
      ...sampleTask,
      state: "blocked",
      blocked: true,
      blocked_reason: "Waiting for API credentials",
    });

    const task = readGnapTask(projectPath, "FA-1");
    expect(task!.state).toBe("blocked");
    expect(task!.blocked).toBe(true);
    expect(task!.blocked_reason).toBe("Waiting for API credentials");
  });

  it("handles task with comments", () => {
    writeGnapTask(projectPath, {
      ...sampleTask,
      comments: [
        { by: "claude-1", at: "2026-03-18T11:00:00Z", text: "Started implementation" },
      ],
    });

    const task = readGnapTask(projectPath, "FA-1");
    expect(task!.comments).toHaveLength(1);
    expect(task!.comments![0].by).toBe("claude-1");
  });
});

describe("agent operations", () => {
  beforeEach(() => {
    initGnapDir(projectPath);
  });

  it("writes and reads an agent", () => {
    const agent: GnapAgent = {
      id: "claude-1",
      name: "Claude Code (int-1)",
      type: "ai",
      status: "active",
      capabilities: ["coding", "testing"],
    };

    writeGnapAgent(projectPath, agent);

    const agents = readGnapAgents(projectPath);
    expect(agents["claude-1"]).toBeDefined();
    expect(agents["claude-1"].name).toBe("Claude Code (int-1)");
    expect(agents["claude-1"].type).toBe("ai");
    expect(agents["claude-1"].status).toBe("active");
  });

  it("updates existing agent in agents.json", () => {
    writeGnapAgent(projectPath, {
      id: "claude-1",
      name: "Claude 1",
      type: "ai",
      status: "active",
    });
    writeGnapAgent(projectPath, {
      id: "claude-2",
      name: "Claude 2",
      type: "ai",
      status: "active",
    });

    const agents = readGnapAgents(projectPath);
    expect(Object.keys(agents)).toHaveLength(2);
    expect(agents["claude-1"]).toBeDefined();
    expect(agents["claude-2"]).toBeDefined();
  });

  it("returns empty object when no agents file exists", () => {
    rmSync(join(projectPath, ".gnap", "agents.json"));
    expect(readGnapAgents(projectPath)).toEqual({});
  });
});

describe("run operations", () => {
  beforeEach(() => {
    initGnapDir(projectPath);
  });

  it("writes and reads a run", () => {
    const run: GnapRun = {
      id: "FA-1-claude-1",
      task_id: "FA-1",
      agent_id: "claude-1",
      state: "running",
      started_at: "2026-03-18T10:00:00Z",
    };

    writeGnapRun(projectPath, run);

    const read = readGnapRun(projectPath, "FA-1-claude-1");
    expect(read).not.toBeNull();
    expect(read!.task_id).toBe("FA-1");
    expect(read!.state).toBe("running");
  });

  it("returns null for nonexistent run", () => {
    expect(readGnapRun(projectPath, "nonexistent")).toBeNull();
  });

  it("updates a run", () => {
    writeGnapRun(projectPath, {
      id: "FA-1-claude-1",
      task_id: "FA-1",
      agent_id: "claude-1",
      state: "running",
      started_at: "2026-03-18T10:00:00Z",
    });

    const updated = updateGnapRun(projectPath, "FA-1-claude-1", {
      state: "completed",
      completed_at: "2026-03-18T12:00:00Z",
      result: "PR #42 merged",
    });

    expect(updated).toBe(true);
    const run = readGnapRun(projectPath, "FA-1-claude-1");
    expect(run!.state).toBe("completed");
    expect(run!.completed_at).toBe("2026-03-18T12:00:00Z");
    expect(run!.result).toBe("PR #42 merged");
  });
});

describe("message operations", () => {
  beforeEach(() => {
    initGnapDir(projectPath);
  });

  it("writes a message", () => {
    const message: GnapMessage = {
      id: "1",
      from: "ao-orchestrator",
      to: ["claude-1"],
      type: "directive",
      text: "Start working on authentication",
      sent_at: "2026-03-18T10:00:00Z",
    };

    writeGnapMessage(projectPath, message);

    const content = readFileSync(join(projectPath, ".gnap", "messages", "1.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.from).toBe("ao-orchestrator");
    expect(parsed.type).toBe("directive");
  });
});

describe("sessionStatusToGnapState", () => {
  it("maps spawning to ready", () => {
    expect(sessionStatusToGnapState("spawning")).toBe("ready");
  });

  it("maps working to in_progress", () => {
    expect(sessionStatusToGnapState("working")).toBe("in_progress");
  });

  it("maps ci_failed to in_progress", () => {
    expect(sessionStatusToGnapState("ci_failed")).toBe("in_progress");
  });

  it("maps changes_requested to in_progress", () => {
    expect(sessionStatusToGnapState("changes_requested")).toBe("in_progress");
  });

  it("maps pr_open to review", () => {
    expect(sessionStatusToGnapState("pr_open")).toBe("review");
  });

  it("maps review_pending to review", () => {
    expect(sessionStatusToGnapState("review_pending")).toBe("review");
  });

  it("maps approved to review", () => {
    expect(sessionStatusToGnapState("approved")).toBe("review");
  });

  it("maps mergeable to review", () => {
    expect(sessionStatusToGnapState("mergeable")).toBe("review");
  });

  it("maps merged to done", () => {
    expect(sessionStatusToGnapState("merged")).toBe("done");
  });

  it("maps done to done", () => {
    expect(sessionStatusToGnapState("done")).toBe("done");
  });

  it("maps needs_input to blocked", () => {
    expect(sessionStatusToGnapState("needs_input")).toBe("blocked");
  });

  it("maps stuck to blocked", () => {
    expect(sessionStatusToGnapState("stuck")).toBe("blocked");
  });

  it("maps errored to blocked", () => {
    expect(sessionStatusToGnapState("errored")).toBe("blocked");
  });

  it("maps killed to cancelled", () => {
    expect(sessionStatusToGnapState("killed")).toBe("cancelled");
  });

  it("maps terminated to cancelled", () => {
    expect(sessionStatusToGnapState("terminated")).toBe("cancelled");
  });
});

describe("gnapTaskStateToRunState", () => {
  it("maps done to completed", () => {
    expect(gnapTaskStateToRunState("done")).toBe("completed");
  });

  it("maps cancelled to cancelled", () => {
    expect(gnapTaskStateToRunState("cancelled")).toBe("cancelled");
  });

  it("maps blocked to failed", () => {
    expect(gnapTaskStateToRunState("blocked")).toBe("failed");
  });

  it("maps in_progress to running", () => {
    expect(gnapTaskStateToRunState("in_progress")).toBe("running");
  });

  it("maps review to running", () => {
    expect(gnapTaskStateToRunState("review")).toBe("running");
  });
});

describe("generateGnapTaskId", () => {
  it("uses issue ID when available", () => {
    expect(generateGnapTaskId("int-1", "INT-123")).toBe("INT-123");
  });

  it("sanitizes issue ID with special characters", () => {
    expect(generateGnapTaskId("int-1", "#472")).toBe("472");
  });

  it("falls back to session ID when no issue", () => {
    expect(generateGnapTaskId("int-1")).toBe("int-1");
  });

  it("sanitizes issue URLs", () => {
    expect(generateGnapTaskId("int-1", "https://github.com/org/repo/issues/42")).toBe(
      "https-github-com-org-repo-issues-42",
    );
  });

  it("falls back to session ID when issue sanitizes to empty string", () => {
    expect(generateGnapTaskId("int-1", "#")).toBe("int-1");
    expect(generateGnapTaskId("int-1", "///")).toBe("int-1");
    expect(generateGnapTaskId("int-1", "@")).toBe("int-1");
  });
});

describe("syncSessionToGnap", () => {
  it("initializes gnap and creates task + agent + run on first sync", () => {
    syncSessionToGnap({
      projectPath,
      sessionId: "int-1",
      agentName: "claude-code",
      issueId: "INT-123",
      issueTitle: "Build authentication",
      issueDescription: "Implement OAuth2",
      status: "spawning",
      branch: "feat/INT-123",
    });

    // GNAP dir should be initialized
    expect(isGnapInitialized(projectPath)).toBe(true);

    // Task should be created
    const task = readGnapTask(projectPath, "INT-123");
    expect(task).not.toBeNull();
    expect(task!.title).toBe("Build authentication");
    expect(task!.desc).toBe("Implement OAuth2");
    expect(task!.state).toBe("ready"); // spawning → ready
    expect(task!.assigned_to).toEqual(["int-1"]);
    expect(task!.created_by).toBe("ao-orchestrator");
    expect(task!.tags).toContain("branch:feat/INT-123");

    // Agent should be registered
    const agents = readGnapAgents(projectPath);
    expect(agents["int-1"]).toBeDefined();
    expect(agents["int-1"].name).toBe("claude-code (int-1)");
    expect(agents["int-1"].type).toBe("ai");

    // Run should be created
    const run = readGnapRun(projectPath, "INT-123-int-1");
    expect(run).not.toBeNull();
    expect(run!.task_id).toBe("INT-123");
    expect(run!.agent_id).toBe("int-1");
    expect(run!.state).toBe("running");
  });

  it("updates existing task on status change", () => {
    // Initial spawn
    syncSessionToGnap({
      projectPath,
      sessionId: "int-1",
      agentName: "claude-code",
      issueId: "INT-123",
      issueTitle: "Build auth",
      status: "spawning",
    });

    // Transition to working
    syncSessionToGnap({
      projectPath,
      sessionId: "int-1",
      agentName: "claude-code",
      issueId: "INT-123",
      status: "working",
    });

    const task = readGnapTask(projectPath, "INT-123");
    expect(task!.state).toBe("in_progress");
    expect(task!.updated_at).toBeDefined();
  });

  it("marks task as blocked when agent is stuck", () => {
    syncSessionToGnap({
      projectPath,
      sessionId: "int-1",
      agentName: "claude-code",
      issueId: "INT-123",
      issueTitle: "Build auth",
      status: "spawning",
    });

    syncSessionToGnap({
      projectPath,
      sessionId: "int-1",
      agentName: "claude-code",
      issueId: "INT-123",
      status: "stuck",
    });

    const task = readGnapTask(projectPath, "INT-123");
    expect(task!.state).toBe("blocked");
    expect(task!.blocked).toBe(true);
    expect(task!.blocked_reason).toContain("stuck");
  });

  it("marks task as done when merged", () => {
    syncSessionToGnap({
      projectPath,
      sessionId: "int-1",
      agentName: "claude-code",
      issueId: "INT-123",
      issueTitle: "Build auth",
      status: "spawning",
    });

    syncSessionToGnap({
      projectPath,
      sessionId: "int-1",
      agentName: "claude-code",
      issueId: "INT-123",
      status: "merged",
    });

    const task = readGnapTask(projectPath, "INT-123");
    expect(task!.state).toBe("done");

    const run = readGnapRun(projectPath, "INT-123-int-1");
    expect(run!.state).toBe("completed");
    expect(run!.completed_at).toBeDefined();

    const agents = readGnapAgents(projectPath);
    expect(agents["int-1"].status).toBe("offline");
  });

  it("creates task without issue using session ID", () => {
    syncSessionToGnap({
      projectPath,
      sessionId: "int-1",
      agentName: "claude-code",
      status: "working",
    });

    const task = readGnapTask(projectPath, "int-1");
    expect(task).not.toBeNull();
    expect(task!.title).toBe("Session int-1");
  });

  it("clears blocked state when transitioning away", () => {
    syncSessionToGnap({
      projectPath,
      sessionId: "int-1",
      agentName: "claude-code",
      issueId: "INT-123",
      issueTitle: "Build auth",
      status: "stuck",
    });

    expect(readGnapTask(projectPath, "INT-123")!.blocked).toBe(true);

    syncSessionToGnap({
      projectPath,
      sessionId: "int-1",
      agentName: "claude-code",
      issueId: "INT-123",
      status: "working",
    });

    const task = readGnapTask(projectPath, "INT-123");
    expect(task!.blocked).toBe(false);
    expect(task!.state).toBe("in_progress");
  });

  it("supports custom gnap directory", () => {
    syncSessionToGnap({
      projectPath,
      gnapDir: ".custom-gnap",
      sessionId: "int-1",
      agentName: "claude-code",
      status: "working",
    });

    expect(isGnapInitialized(projectPath, ".custom-gnap")).toBe(true);
    expect(readGnapTask(projectPath, "int-1", ".custom-gnap")).not.toBeNull();
  });
});

describe("syncDecompositionToGnap", () => {
  it("creates parent and child tasks", () => {
    syncDecompositionToGnap({
      projectPath,
      planId: "plan-1",
      rootTaskDescription: "Build full-stack app",
      tasks: [
        { id: "task-1", description: "Implement backend API" },
        { id: "task-2", description: "Build frontend UI", parentId: "plan-1" },
        { id: "task-3", description: "Write integration tests" },
      ],
    });

    // Parent task
    const parent = readGnapTask(projectPath, "plan-1");
    expect(parent).not.toBeNull();
    expect(parent!.title).toBe("Build full-stack app");
    expect(parent!.state).toBe("in_progress");
    expect(parent!.tags).toContain("decomposed");

    // Child tasks
    const task1 = readGnapTask(projectPath, "task-1");
    expect(task1).not.toBeNull();
    expect(task1!.title).toBe("Implement backend API");
    expect(task1!.parent).toBe("plan-1");
    expect(task1!.state).toBe("ready"); // No session assigned

    const task2 = readGnapTask(projectPath, "task-2");
    expect(task2!.parent).toBe("plan-1");

    const task3 = readGnapTask(projectPath, "task-3");
    expect(task3!.parent).toBe("plan-1");
  });

  it("multiple decompositions do not collide", () => {
    syncDecompositionToGnap({
      projectPath,
      planId: "plan-a",
      rootTaskDescription: "First plan",
      tasks: [{ id: "a-1", description: "Task A" }],
    });
    syncDecompositionToGnap({
      projectPath,
      planId: "plan-b",
      rootTaskDescription: "Second plan",
      tasks: [{ id: "b-1", description: "Task B" }],
    });

    const planA = readGnapTask(projectPath, "plan-a");
    const planB = readGnapTask(projectPath, "plan-b");
    expect(planA!.title).toBe("First plan");
    expect(planB!.title).toBe("Second plan");

    const taskA = readGnapTask(projectPath, "a-1");
    expect(taskA!.parent).toBe("plan-a");
    const taskB = readGnapTask(projectPath, "b-1");
    expect(taskB!.parent).toBe("plan-b");
  });

  it("marks tasks with sessions as in_progress", () => {
    syncDecompositionToGnap({
      projectPath,
      planId: "plan-2",
      rootTaskDescription: "Build app",
      tasks: [
        { id: "task-1", description: "Backend", sessionId: "int-1" },
        { id: "task-2", description: "Frontend" },
      ],
    });

    const task1 = readGnapTask(projectPath, "task-1");
    expect(task1!.state).toBe("in_progress");
    expect(task1!.assigned_to).toEqual(["int-1"]);

    const task2 = readGnapTask(projectPath, "task-2");
    expect(task2!.state).toBe("ready");
    expect(task2!.assigned_to).toEqual([]);
  });

  it("initializes gnap directory if needed", () => {
    syncDecompositionToGnap({
      projectPath,
      rootTaskDescription: "Build app",
      tasks: [{ id: "task-1", description: "Backend" }],
    });

    expect(isGnapInitialized(projectPath)).toBe(true);
  });
});
