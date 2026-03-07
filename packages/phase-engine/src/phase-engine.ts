/**
 * Phase Engine — orchestrates team execution through sequential phases.
 *
 * The phase engine is the core state machine that drives team execution:
 *   PLAN -> VALIDATE -> IMPLEMENT -> INTEGRATE -> REVIEW -> REVISE -> TEST -> FINALIZE -> REFINE
 *
 * Each phase:
 *   1. Spawns appropriate agent(s) via the Runtime plugin
 *   2. Monitors agent status via .agents/status/ files
 *   3. Runs post-completion steps (file scope audit, commits)
 *   4. Transitions to the next phase
 *
 * Agents are short-lived: each phase spawns a new process.
 * .agents/ is the persistent memory between phases.
 */

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  Phase,
  PhaseState,
  PhaseRecord,
  TeamDefinition,
  TeamSessionState,
  Plan,
  TestTaskConfig,
  TestTaskResult,
} from "@composio/ao-core";
import { AgentBus } from "@composio/ao-agent-bus";
import { validatePlan } from "./plan-validator.js";
import { auditFileScope, revertOutOfScopeFiles } from "./file-scope-audit.js";

const execFileAsync = promisify(execFile);

/** Configuration for the phase engine */
export interface PhaseEngineConfig {
  /** Path to the worktree */
  worktreePath: string;
  /** Team definition */
  team: TeamDefinition;
  /** Team preset name */
  teamName: string;
  /** Task description or issue body */
  taskDescription: string;
  /** Test task configurations */
  testTasks?: Record<string, TestTaskConfig>;
  /** Max plan validation retries (default: 2) */
  maxPlanRetries?: number;
  /** Polling interval for agent status (ms, default: 5000) */
  pollIntervalMs?: number;
  /** Callback for spawning agents */
  spawnAgent: (
    agentName: string,
    role: string,
    phase: Phase,
    context: AgentSpawnContext,
  ) => Promise<void>;
  /** Callback for killing agents */
  killAgent?: (agentName: string) => Promise<void>;
  /** Callback for human notification */
  notifyHuman?: (message: string, priority: "urgent" | "info") => Promise<void>;
}

/** Context provided to agent spawn callback */
export interface AgentSpawnContext {
  /** The AgentBus instance for this team */
  bus: AgentBus;
  /** The current plan (if available) */
  plan?: Plan;
  /** Files assigned to this agent */
  fileScope: string[];
  /** Shared files (read-only during implement) */
  sharedFiles: string[];
  /** Task description */
  taskDescription: string;
  /** Phase-specific instructions */
  phaseInstructions: string;
  /** Bootstrap environment variables */
  environment: Record<string, string>;
}

/**
 * PhaseEngine drives team execution through sequential phases.
 */
export class PhaseEngine {
  private readonly config: PhaseEngineConfig;
  private readonly bus: AgentBus;
  private readonly agentsDir: string;
  private state: TeamSessionState;
  private aborted = false;
  private violationCounts = new Map<string, number>();

  constructor(config: PhaseEngineConfig) {
    this.config = config;
    this.agentsDir = join(config.worktreePath, ".agents");
    this.bus = new AgentBus({ agentsDir: this.agentsDir });

    this.state = {
      teamName: config.teamName,
      team: config.team,
      currentPhase: config.team.phases[0],
      phases: config.team.phases.map((p) => ({
        phase: p,
        state: "pending" as PhaseState,
        attempts: 0,
      })),
      reviewCycle: 0,
      worktreePath: config.worktreePath,
      agentsDir: this.agentsDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /** Get the current team session state */
  getState(): TeamSessionState {
    return { ...this.state };
  }

  /** Get the AgentBus instance */
  getBus(): AgentBus {
    return this.bus;
  }

  /** Initialize the .agents/ directory and start execution */
  async run(): Promise<TeamSessionState> {
    this.bus.init();
    this.saveState();

    for (const phaseRecord of this.state.phases) {
      if (this.aborted) break;

      this.state.currentPhase = phaseRecord.phase;
      phaseRecord.state = "running";
      phaseRecord.startedAt = new Date().toISOString();
      this.saveState();

      try {
        await this.executePhase(phaseRecord.phase);
        phaseRecord.state = "completed";
        phaseRecord.completedAt = new Date().toISOString();
      } catch (err) {
        phaseRecord.state = "failed";
        phaseRecord.error = err instanceof Error ? err.message : String(err);
        phaseRecord.completedAt = new Date().toISOString();

        // Non-blocking phases don't abort the pipeline
        if (phaseRecord.phase === "refine") {
          // Refine failure is non-blocking
          phaseRecord.state = "skipped";
        } else {
          this.aborted = true;
        }
      }

      this.state.updatedAt = new Date().toISOString();
      this.saveState();
    }

    return this.state;
  }

  /** Abort the engine (e.g. from ao stop) */
  abort(reason: string): void {
    this.aborted = true;
    this.bus.writeControl({
      signal: "shutdown",
      ts: new Date().toISOString(),
      reason,
    });
  }

  // ===========================================================================
  // PHASE EXECUTION
  // ===========================================================================

  private async executePhase(phase: Phase): Promise<void> {
    switch (phase) {
      case "plan":
        return this.executePlanPhase();
      case "validate":
        return this.executeValidatePhase();
      case "implement":
        return this.executeImplementPhase();
      case "integrate":
        return this.executeIntegratePhase();
      case "review":
        return this.executeReviewPhase();
      case "revise":
        return this.executeRevisePhase();
      case "test":
        return this.executeTestPhase();
      case "finalize":
        return this.executeFinalizePhase();
      case "refine":
        return this.executeRefinePhase();
    }
  }

  // --- PLAN PHASE ---

  private async executePlanPhase(): Promise<void> {
    const maxRetries = this.config.maxPlanRetries ?? 2;
    const phaseRecord = this.getPhaseRecord("plan");

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      phaseRecord.attempts = attempt + 1;

      await this.spawnAndWait("planner", "planner", "plan", {
        phaseInstructions: [
          "You are the planner. Analyze the task and create a structured plan.",
          "Use ao-plan commands to build the plan:",
          "  1. ao-plan init \"<summary>\"",
          "  2. ao-plan add-unit --id wu-N --desc \"...\" --assigned-to <agent> --files <files> --criteria \"...\"",
          "  3. ao-plan shared-files <files that multiple agents read>",
          "  4. ao-plan finalize",
          "  5. ao-status done",
          "",
          `Available agents: ${Object.keys(this.config.team.agents).join(", ")}`,
          "",
          "Rules:",
          "- Each file must appear in exactly one work unit's files array.",
          "- shared_files must not appear in any work unit's files array.",
          "- Every assigned agent must appear in integrate_order.",
        ].join("\n"),
      });

      // Check if plan was written
      const plan = this.bus.readPlan();
      if (plan) {
        this.state.plan = plan;
        return;
      }

      if (attempt < maxRetries) {
        this.bus.sendMessage("engine", "planner", "plan", "Plan was not written. Please try again using ao-plan commands.", { type: "system" });
      }
    }

    throw new Error("Plan phase failed after max retries — planner did not produce a valid plan");
  }

  // --- VALIDATE PHASE ---

  private async executeValidatePhase(): Promise<void> {
    const plan = this.bus.readPlan();
    if (!plan) {
      throw new Error("No plan.json found — validate phase requires a plan");
    }

    const result = validatePlan(plan, this.config.team);

    if (!result.valid) {
      const errorMessages = result.errors.map((e) => `  - ${e.field}: ${e.message}`).join("\n");

      // Send errors back to planner and re-enter plan phase
      this.bus.sendMessage(
        "engine",
        "planner",
        "validate",
        `Plan validation failed:\n${errorMessages}\n\nPlease fix and re-submit.`,
        { type: "system" },
      );

      throw new Error(`Plan validation failed:\n${errorMessages}`);
    }

    this.state.plan = plan;
  }

  // --- IMPLEMENT PHASE ---

  private async executeImplementPhase(): Promise<void> {
    const plan = this.state.plan;
    if (!plan) throw new Error("No plan available for implement phase");

    // Group work units by agent
    const agentUnits = new Map<string, typeof plan.workUnits>();
    for (const wu of plan.workUnits) {
      const units = agentUnits.get(wu.assignedTo) ?? [];
      units.push(wu);
      agentUnits.set(wu.assignedTo, units);
    }

    // Spawn agents (can run in parallel for non-overlapping file scopes)
    const promises: Promise<void>[] = [];

    for (const [agentName, units] of agentUnits) {
      const files = units.flatMap((wu) => wu.files);
      const criteria = units.map((wu) => `[${wu.id}] ${wu.criteria}`).join("\n");

      const promise = (async () => {
        await this.spawnAndWait(agentName, this.getAgentRole(agentName), "implement", {
          fileScope: files,
          sharedFiles: plan.sharedFiles,
          phaseInstructions: [
            `You are implementing the following work units:`,
            ...units.map((wu) => `  - ${wu.id}: ${wu.description}`),
            "",
            `Your assigned files (exclusive write scope): ${files.join(", ")}`,
            `Shared files (read-only, do NOT modify): ${plan.sharedFiles.join(", ")}`,
            "",
            `Acceptance criteria:\n${criteria}`,
            "",
            "When done, run: ao-status done",
          ].join("\n"),
        });

        // Post-completion: file scope audit
        await this.runFileScopeAudit(agentName, files);

        // Commit
        await this.commitPhase("implement", units[0].description);
      })();

      promises.push(promise);
    }

    await Promise.all(promises);
  }

  // --- INTEGRATE PHASE ---

  private async executeIntegratePhase(): Promise<void> {
    const plan = this.state.plan;
    if (!plan) throw new Error("No plan available for integrate phase");

    // Sequential dispatch in integrate_order
    for (const agentName of plan.integrateOrder) {
      const units = plan.workUnits.filter((wu) => wu.assignedTo === agentName);
      const files = units.flatMap((wu) => wu.files);

      await this.spawnAndWait(agentName, this.getAgentRole(agentName), "integrate", {
        fileScope: [...files, ...plan.sharedFiles], // Can modify shared files during integrate
        phaseInstructions: [
          "Integration phase: wire up your implementation with the rest of the codebase.",
          `You may now modify shared files: ${plan.sharedFiles.join(", ")}`,
          `Your files: ${files.join(", ")}`,
          "",
          "Ensure imports, exports, and wiring are correct.",
          "When done, run: ao-status done",
        ].join("\n"),
      });

      // File scope audit (including shared files as allowed)
      await this.runFileScopeAudit(agentName, [...files, ...plan.sharedFiles]);

      // Commit
      await this.commitPhase("integrate", `wire up ${units[0]?.id ?? agentName}`);
    }
  }

  // --- REVIEW PHASE ---

  private async executeReviewPhase(): Promise<void> {
    // Get git diff for reviewer context
    let diff: string;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "HEAD~1"],
        { cwd: this.config.worktreePath, timeout: 30_000 },
      );
      diff = stdout;
    } catch {
      diff = "(Unable to generate diff)";
    }

    await this.spawnAndWait("reviewer", "reviewer", "review", {
      phaseInstructions: [
        "Review the implementation. Read the git diff and plan, then write a review report.",
        "",
        "Write your review to: ao-artifact write review-report.md",
        "Use ao-learn to record patterns and pitfalls you discover.",
        "",
        "If you find blockers, send revision requests:",
        '  ao-msg driver "fix issue description" --type revision_request --priority high',
        "",
        "When done, run: ao-status done",
        "",
        "--- Git Diff ---",
        diff.slice(0, 10000), // Truncate very large diffs
      ].join("\n"),
    });
  }

  // --- REVISE PHASE ---

  private async executeRevisePhase(): Promise<void> {
    const maxCycles = this.config.team.maxReviewCycles ?? 2;

    // Check if there are revision requests
    const messages = this.bus.readMessagesFor("driver", { from: "reviewer" });
    const revisionRequests = messages.filter((m) => m.type === "revision_request");

    if (revisionRequests.length === 0) {
      return; // Nothing to revise
    }

    if (this.state.reviewCycle >= maxCycles) {
      // Exhausted review cycles — notify human
      await this.config.notifyHuman?.(
        `Review cycle exhaustion (${maxCycles} cycles). Applying needs-human-review label.`,
        "urgent",
      );
      throw new Error(`Review cycle exhaustion after ${maxCycles} cycles`);
    }

    this.state.reviewCycle++;

    const plan = this.state.plan;
    const driverFiles = plan
      ? plan.workUnits
          .filter((wu) => wu.assignedTo === "driver")
          .flatMap((wu) => wu.files)
      : [];

    await this.spawnAndWait("driver", "driver", "revise", {
      fileScope: driverFiles,
      phaseInstructions: [
        "Address the review feedback. Check your inbox for revision requests:",
        "  ao-inbox --from reviewer",
        "",
        "Fix each issue, then: ao-status done",
      ].join("\n"),
    });

    // File scope audit
    await this.runFileScopeAudit("driver", driverFiles);

    // Commit
    await this.commitPhase("revise", `address review feedback (cycle ${this.state.reviewCycle})`);
  }

  // --- TEST PHASE ---

  private async executeTestPhase(): Promise<void> {
    if (!this.config.testTasks || Object.keys(this.config.testTasks).length === 0) {
      return; // No test tasks configured
    }

    const results: TestTaskResult[] = [];
    let anyFailed = false;

    for (const [name, task] of Object.entries(this.config.testTasks)) {
      const result = await this.runTestTask(name, task);
      results.push(result);
      if (!result.passed) anyFailed = true;
    }

    // Write test results as artifact
    this.bus.writeArtifact("test-results.json", JSON.stringify(results, null, 2));

    if (anyFailed) {
      // Check for on_fail: agent tasks
      const agentTasks = Object.entries(this.config.testTasks).filter(
        ([name, task]) => task.onFail === "agent" && results.find((r) => r.name === name && !r.passed),
      );

      if (agentTasks.length > 0) {
        // Spawn tester agent
        const failedOutput = results
          .filter((r) => !r.passed)
          .map((r) => `[${r.name}] exit=${r.exitCode}\n${r.output}`)
          .join("\n\n");

        await this.spawnAndWait("tester", "tester", "test", {
          phaseInstructions: [
            "Tests are failing. Fix the issues and ensure all tests pass.",
            "",
            "Failed test output:",
            failedOutput.slice(0, 5000),
            "",
            "When done, run: ao-status done",
          ].join("\n"),
        });

        // Commit tester fixes
        await this.commitPhase("test", "fix failing tests");
      }

      // Check if required tests still fail
      const requiredFailures = Object.entries(this.config.testTasks)
        .filter(([name, task]) => task.required && results.find((r) => r.name === name && !r.passed));

      if (requiredFailures.length > 0) {
        const names = requiredFailures.map(([n]) => n).join(", ");
        throw new Error(`Required test tasks failed: ${names}`);
      }
    }
  }

  // --- FINALIZE PHASE ---

  private async executeFinalizePhase(): Promise<void> {
    // No new commit — the phase engine creates the PR
    // In v1, we just log completion. PR creation is delegated to the caller.
    this.bus.sendMessage("engine", "all", "finalize", "All phases complete. PR ready.", {
      type: "system",
    });
  }

  // --- REFINE PHASE ---

  private async executeRefinePhase(): Promise<void> {
    // Check if learnings are enabled (check for .ao/learnings/ directory)
    const learningsDir = join(this.config.worktreePath, ".ao", "learnings");
    if (!existsSync(learningsDir)) {
      return; // Learnings not initialized, skip refine
    }

    // Read buffered learnings
    const buffer = this.bus.readLearningsBuffer();
    if (buffer.length === 0) {
      return; // No learnings to process
    }

    await this.spawnAndWait("planner", "planner", "refine", {
      phaseInstructions: [
        "Refinement phase: review buffered learnings and update project knowledge.",
        "",
        "Buffered learnings from this task:",
        ...buffer.map((e) => `  [${e.category}] ${e.description} (by ${e.recordedBy})`),
        "",
        "Use ao-refine commands to update .ao/learnings/ files:",
        '  ao-refine add convention "new pattern"',
        '  ao-refine remove pitfall "old entry" --reason "why"',
        '  ao-refine update decision "entry" --append "new info"',
        '  ao-refine confirm pitfall "entry to keep"',
        "",
        "When done, run: ao-status done",
      ].join("\n"),
    });

    // Commit learnings
    try {
      await this.commitPhase("refine", "update project learnings");
    } catch {
      // Refine commit failure is non-blocking
    }
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /** Spawn an agent and wait for it to report done */
  private async spawnAndWait(
    agentName: string,
    role: string,
    phase: Phase,
    extra: {
      fileScope?: string[];
      sharedFiles?: string[];
      phaseInstructions?: string;
    } = {},
  ): Promise<void> {
    // Initialize agent status
    this.bus.initAgentStatus(agentName, role, phase);

    const plan = this.state.plan;
    const fileScope = extra.fileScope ?? [];
    const sharedFiles = extra.sharedFiles ?? plan?.sharedFiles ?? [];

    const environment: Record<string, string> = {
      AO_AGENT_NAME: agentName,
      AO_PHASE: phase,
      AO_WORKTREE: this.config.worktreePath,
      AO_AGENTS_DIR: this.agentsDir,
      AO_FILE_SCOPE: fileScope.join(","),
      AO_SHARED_FILES: sharedFiles.join(","),
    };

    const context: AgentSpawnContext = {
      bus: this.bus,
      plan,
      fileScope,
      sharedFiles,
      taskDescription: this.config.taskDescription,
      phaseInstructions: extra.phaseInstructions ?? "",
      environment,
    };

    await this.config.spawnAgent(agentName, role, phase, context);

    // Wait for agent to report done
    await this.waitForAgentDone(agentName);
  }

  /** Poll agent status until done or failed */
  private async waitForAgentDone(agentName: string): Promise<void> {
    const pollInterval = this.config.pollIntervalMs ?? 5000;
    const maxWaitMs = 30 * 60 * 1000; // 30 minutes max
    const startTime = Date.now();

    while (true) {
      if (this.aborted) {
        throw new Error("Engine aborted");
      }

      // Check control signal
      const control = this.bus.readControl();
      if (control?.signal === "shutdown" || control?.signal === "abort") {
        this.aborted = true;
        throw new Error(`Engine received ${control.signal} signal: ${control.reason ?? "no reason"}`);
      }

      const status = this.bus.readStatus(agentName);

      if (status?.state === "done") {
        return;
      }

      if (status?.state === "failed") {
        throw new Error(`Agent ${agentName} reported failure`);
      }

      if (status?.state === "crashed") {
        throw new Error(`Agent ${agentName} crashed`);
      }

      if (Date.now() - startTime > maxWaitMs) {
        throw new Error(`Agent ${agentName} timed out after 30 minutes`);
      }

      await sleep(pollInterval);
    }
  }

  /** Run a file scope audit and handle violations */
  private async runFileScopeAudit(agentName: string, allowedFiles: string[]): Promise<void> {
    const result = await auditFileScope({
      worktreePath: this.config.worktreePath,
      allowedFiles,
    });

    if (!result.inScope) {
      const key = `${agentName}:${this.state.currentPhase}`;
      const count = (this.violationCounts.get(key) ?? 0) + 1;
      this.violationCounts.set(key, count);

      // Revert out-of-scope files
      await revertOutOfScopeFiles(this.config.worktreePath, result.outOfScopeFiles);

      if (count >= 2) {
        await this.config.notifyHuman?.(
          `Agent ${agentName} violated file scope ${count} times in ${this.state.currentPhase} phase. Aborting.`,
          "urgent",
        );
        throw new Error(
          `Agent ${agentName} violated file scope ${count} times — max 2 violations per phase`,
        );
      }

      // Message agent about the violation
      this.bus.sendMessage(
        "engine",
        agentName,
        this.state.currentPhase,
        `File scope violation: you modified files outside your scope: ${result.outOfScopeFiles.join(", ")}. These changes have been reverted. Only modify: ${allowedFiles.join(", ")}`,
        { type: "system", priority: "high" },
      );
    }
  }

  /** Run a test task and return the result */
  private async runTestTask(name: string, task: TestTaskConfig): Promise<TestTaskResult> {
    const maxRetries = task.maxRetries ?? 0;
    const timeoutMs = task.timeout * 1000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();

      try {
        const { stdout, stderr } = await execFileAsync(
          "sh",
          ["-c", task.command],
          { cwd: this.config.worktreePath, timeout: timeoutMs },
        );

        return {
          name,
          passed: true,
          exitCode: 0,
          output: stdout + stderr,
          attempt: attempt + 1,
          durationMs: Date.now() - startTime,
        };
      } catch (err: unknown) {
        const error = err as { code?: number; stdout?: string; stderr?: string };
        if (attempt >= maxRetries) {
          return {
            name,
            passed: false,
            exitCode: error.code ?? 1,
            output: (error.stdout ?? "") + (error.stderr ?? ""),
            attempt: attempt + 1,
            durationMs: Date.now() - startTime,
          };
        }
      }
    }

    // Unreachable, but TypeScript needs it
    return { name, passed: false, exitCode: 1, output: "", attempt: 1, durationMs: 0 };
  }

  /** Git commit for a phase */
  private async commitPhase(phase: Phase, detail: string): Promise<void> {
    try {
      await execFileAsync("git", ["add", "-A"], {
        cwd: this.config.worktreePath,
        timeout: 30_000,
      });

      await execFileAsync(
        "git",
        ["commit", "-m", `[${phase}] ${detail}`, "--allow-empty"],
        { cwd: this.config.worktreePath, timeout: 30_000 },
      );
    } catch {
      // Commit may fail if there are no changes — that's ok
    }
  }

  /** Get the role for a named agent */
  private getAgentRole(agentName: string): string {
    return this.config.team.agents[agentName]?.role ?? "driver";
  }

  /** Get a phase record by phase name */
  private getPhaseRecord(phase: Phase): PhaseRecord {
    const record = this.state.phases.find((p) => p.phase === phase);
    if (!record) throw new Error(`Phase record not found: ${phase}`);
    return record;
  }

  /** Save state to .agents/ directory */
  private saveState(): void {
    const statePath = join(this.agentsDir, "team-state.json");
    mkdirSync(this.agentsDir, { recursive: true });
    writeFileSync(statePath, JSON.stringify(this.state, null, 2), "utf-8");
  }
}

/** Helper: sleep for ms */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
