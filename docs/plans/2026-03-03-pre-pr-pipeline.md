# Pre-PR Quality Pipeline — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a 4-stage pre-PR pipeline (checks → tests → review → PR) that ensures agent code is typechecked, tested, and reviewed by separate Claude Code sessions before any PR is opened.

**Architecture:** The lifecycle manager detects when a coder agent is idle with commits but no PR, then hands off to a new `PipelineManager`. The pipeline runs automated checks, spawns a test-writing agent, then spawns a review agent — all in the coder's existing workspace. On approval, the coder opens the PR. On failure, feedback is sent back to the coder to iterate.

**Tech Stack:** TypeScript (ESM), Node.js, Zod config validation, existing session-manager spawn flow, flat-file metadata.

**Design doc:** `docs/plans/2026-03-03-pre-pr-pipeline-design.md`

---

## Key Decisions

- **Test/review agents reuse the coder's workspace** — the coder is idle while pipeline runs, so no conflicts. No new worktrees needed.
- **`spawn()` gets a `workspacePath` option** — skip workspace creation when launching pipeline agents in an existing workspace.
- **Session metadata tracks `role` and `parentSession`** — distinguish coder/tester/reviewer and link them.
- **New statuses: `checking`, `testing`, `reviewing`** — extend the lifecycle state machine for the pre-PR loop.
- **Pipeline is configurable per-project** — checks commands, test/review prompts, iteration limits, skip flags.
- **Opus for all agents** — coder, tester, reviewer all use the same model.

## Workspace Sharing Strategy

When the pipeline triggers, the coder agent is idle or exited. The test and review agents spawn in the coder's workspace directory (no new worktree). Sequence:

1. Coder goes idle → pipeline detects
2. Pipeline runs automated checks in coder's workspace via `execFile`
3. Pipeline spawns test agent → `workspacePath: coderSession.workspacePath`
4. Test agent commits tests to the same branch, exits
5. Pipeline spawns review agent → same workspace
6. Review agent reads diff + tests, writes verdict, exits
7. Pipeline reads verdict, routes feedback or approval to coder

---

### Task 1: Extend Core Types

**Files:**
- Modify: `packages/core/src/types.ts`
- Test: `packages/core/src/__tests__/types.test.ts`

**Step 1: Add new SessionStatus values**

In `packages/core/src/types.ts`, find the `SessionStatus` type union (line ~26) and add three new statuses:

```typescript
export type SessionStatus =
  | "spawning"
  | "working"
  | "checking"    // NEW: running automated checks (typecheck/lint/test)
  | "testing"     // NEW: test agent writing tests
  | "reviewing"   // NEW: review agent examining code
  | "pr_open"
  // ... rest unchanged
```

**Step 2: Add `workspacePath` to SessionSpawnConfig**

Find `SessionSpawnConfig` (line ~173) and add:

```typescript
export interface SessionSpawnConfig {
  projectId: string;
  issueId?: string;
  branch?: string;
  prompt?: string;
  agent?: string;
  /** Use an existing workspace instead of creating one. For pipeline agents. */
  workspacePath?: string;
  /** Role for this session: coder (default), tester, reviewer */
  role?: "coder" | "tester" | "reviewer";
  /** Parent session ID for pipeline agents */
  parentSession?: string;
  /** Skip pipeline stages */
  skipPipeline?: boolean;
}
```

**Step 3: Add pipeline config types**

Add after the existing `ReactionConfig` interface:

```typescript
export interface PipelineConfig {
  /** Enable the pre-PR pipeline (default: true) */
  enabled: boolean;
  /** Commands to run in the automated checks stage */
  checkCommands: string[];
  /** Test agent configuration */
  testAgent: PipelineAgentConfig;
  /** Review agent configuration */
  reviewAgent: PipelineAgentConfig;
  /** Max total pipeline iterations before escalating to human */
  maxIterations: number;
}

export interface PipelineAgentConfig {
  /** Agent plugin to use (default: "claude-code") */
  agent: string;
  /** Model override */
  model: string;
  /** Custom prompt file path (relative to project) */
  promptFile?: string;
  /** Max retries for this stage */
  maxRetries: number;
}
```

**Step 4: Add pipeline field to OrchestratorConfig**

Find the `OrchestratorConfig` interface and add:

```typescript
export interface OrchestratorConfig {
  // ... existing fields ...
  /** Pre-PR quality pipeline config */
  pipeline?: PipelineConfig;
}
```

**Step 5: Add `role` and `parentSession` to SessionMetadata**

Find `SessionMetadata` (line ~1163) — `role` already exists, add `parentSession`:

```typescript
export interface SessionMetadata {
  // ... existing fields ...
  role?: string;
  parentSession?: string;  // NEW: links tester/reviewer back to coder session
}
```

**Step 6: Update TERMINAL_STATUSES if needed**

The new statuses (`checking`, `testing`, `reviewing`) are NOT terminal — they're active pipeline states. No change needed to `TERMINAL_STATUSES`.

**Step 7: Run typecheck**

Run: `cd /Users/mattschulz/code/_rtf/agent-orchestrator && pnpm typecheck`
Expected: PASS (new types are additive, nothing uses them yet)

**Step 8: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(types): add pipeline statuses, config types, and spawn options"
```

---

### Task 2: Add Pipeline Config to Zod Schema

**Files:**
- Modify: `packages/core/src/config.ts`
- Test: verify with `pnpm typecheck`

**Step 1: Add PipelineAgentConfig Zod schema**

In `packages/core/src/config.ts`, after the existing `ReactionConfigSchema`, add:

```typescript
const PipelineAgentConfigSchema = z.object({
  agent: z.string().default("claude-code"),
  model: z.string().default("opus"),
  promptFile: z.string().optional(),
  maxRetries: z.number().default(3),
});

const PipelineConfigSchema = z.object({
  enabled: z.boolean().default(true),
  checkCommands: z.array(z.string()).default(["pnpm typecheck", "pnpm lint", "pnpm test"]),
  testAgent: PipelineAgentConfigSchema.default({}),
  reviewAgent: PipelineAgentConfigSchema.default({}),
  maxIterations: z.number().default(5),
});
```

**Step 2: Add pipeline to OrchestratorConfigSchema**

Find `OrchestratorConfigSchema` and add:

```typescript
const OrchestratorConfigSchema = z.object({
  // ... existing fields ...
  pipeline: PipelineConfigSchema.optional(),
});
```

**Step 3: Export the parsed pipeline config**

Make sure `loadConfig()` passes the pipeline config through. Since it's on the top-level schema, Zod will parse it automatically.

**Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/config.ts
git commit -m "feat(config): add pipeline section to Zod schema"
```

---

### Task 3: Extend spawn() to Support Existing Workspace

**Files:**
- Modify: `packages/core/src/session-manager.ts`
- Test: `packages/core/src/__tests__/session-manager.test.ts`

**Step 1: Write a failing test**

Create or extend test file. Test that spawn with `workspacePath` skips workspace creation:

```typescript
it("should skip workspace creation when workspacePath is provided", async () => {
  const session = await sessionManager.spawn({
    projectId: "test-project",
    workspacePath: "/tmp/existing-workspace",
    prompt: "Test prompt",
    role: "tester",
    parentSession: "parent-123",
  });

  expect(session.workspacePath).toBe("/tmp/existing-workspace");
  expect(session.metadata.role).toBe("tester");
  expect(session.metadata.parentSession).toBe("parent-123");
  // workspace.create should NOT have been called
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- --grep "workspacePath"`
Expected: FAIL

**Step 3: Modify spawn() in session-manager.ts**

In the `spawn()` function, find **Step 5: Create Workspace** (around line 414). Add a conditional:

```typescript
let workspacePath: string;
let branch: string;

if (spawnConfig.workspacePath) {
  // Pipeline agent: reuse existing workspace
  workspacePath = spawnConfig.workspacePath;
  // Detect current branch from the workspace
  const { stdout } = await execFileAsync(
    "git", ["branch", "--show-current"],
    { cwd: workspacePath, timeout: 10_000 }
  );
  branch = stdout.trim();
} else {
  // Normal flow: create new workspace
  // ... existing workspace creation code ...
}
```

**Step 4: Write role and parentSession to metadata**

In the metadata write step (around line 544), add:

```typescript
writeMetadata(sessionsDir, sessionId, {
  // ... existing fields ...
  role: spawnConfig.role ?? "coder",
  parentSession: spawnConfig.parentSession,
});
```

**Step 5: Run test to verify it passes**

Run: `pnpm test -- --grep "workspacePath"`
Expected: PASS

**Step 6: Run full typecheck + tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

**Step 7: Commit**

```bash
git add packages/core/src/session-manager.ts packages/core/src/__tests__/session-manager.test.ts
git commit -m "feat(session-manager): support workspacePath for pipeline agents"
```

---

### Task 4: Build Pipeline Manager — Skeleton

**Files:**
- Create: `packages/core/src/pipeline-manager.ts`
- Test: `packages/core/src/__tests__/pipeline-manager.test.ts`

**Step 1: Write a failing test for the pipeline manager interface**

```typescript
import { describe, it, expect } from "vitest";
import { createPipelineManager } from "../pipeline-manager.js";

describe("PipelineManager", () => {
  it("should create a pipeline manager with run method", () => {
    const pm = createPipelineManager({
      sessionManager: {} as any,
      config: { pipeline: { enabled: true, checkCommands: [], testAgent: {}, reviewAgent: {}, maxIterations: 5 } } as any,
      registry: {} as any,
    });

    expect(pm).toBeDefined();
    expect(typeof pm.run).toBe("function");
    expect(typeof pm.isRunning).toBe("function");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/core/src/__tests__/pipeline-manager.test.ts`
Expected: FAIL — module not found

**Step 3: Create pipeline-manager.ts skeleton**

```typescript
import type {
  Session,
  SessionManager,
  OrchestratorConfig,
  PipelineConfig,
} from "./types.js";
import type { PluginRegistry } from "./registry.js";

export interface PipelineDeps {
  sessionManager: SessionManager;
  config: OrchestratorConfig;
  registry: PluginRegistry;
}

export interface PipelineResult {
  stage: "checks" | "testing" | "reviewing" | "approved";
  success: boolean;
  message?: string;
  iteration: number;
}

export interface PipelineManager {
  /** Run the full pipeline for a coder session */
  run(session: Session): Promise<PipelineResult>;
  /** Check if pipeline is currently running for a session */
  isRunning(sessionId: string): boolean;
}

export function createPipelineManager(deps: PipelineDeps): PipelineManager {
  const running = new Set<string>();

  return {
    async run(session: Session): Promise<PipelineResult> {
      if (running.has(session.id)) {
        return { stage: "checks", success: false, message: "Pipeline already running", iteration: 0 };
      }
      running.add(session.id);

      try {
        const pipelineConfig = deps.config.pipeline;
        if (!pipelineConfig?.enabled) {
          return { stage: "approved", success: true, message: "Pipeline disabled", iteration: 0 };
        }

        const maxIterations = pipelineConfig.maxIterations;

        for (let iteration = 1; iteration <= maxIterations; iteration++) {
          // Stage 1: Automated checks
          const checksResult = await runChecks(session, pipelineConfig, deps);
          if (!checksResult.success) {
            await sendFeedback(session, checksResult.message ?? "Checks failed", deps);
            await awaitCoderFix(session, deps);
            continue;
          }

          // Stage 2: Test agent
          const testResult = await runTestAgent(session, pipelineConfig, deps);
          if (!testResult.success) {
            await sendFeedback(session, testResult.message ?? "Tests failed", deps);
            await awaitCoderFix(session, deps);
            continue;
          }

          // Stage 3: Review agent
          const reviewResult = await runReviewAgent(session, pipelineConfig, deps);
          if (!reviewResult.success) {
            await sendFeedback(session, reviewResult.message ?? "Review failed", deps);
            await awaitCoderFix(session, deps);
            continue;
          }

          return { stage: "approved", success: true, iteration };
        }

        return {
          stage: "checks",
          success: false,
          message: `Pipeline exhausted ${maxIterations} iterations`,
          iteration: maxIterations,
        };
      } finally {
        running.delete(session.id);
      }
    },

    isRunning(sessionId: string): boolean {
      return running.has(sessionId);
    },
  };
}

// Stub implementations — filled in by Tasks 5, 6, 7
async function runChecks(
  _session: Session,
  _config: PipelineConfig,
  _deps: PipelineDeps,
): Promise<{ success: boolean; message?: string }> {
  return { success: true };
}

async function runTestAgent(
  _session: Session,
  _config: PipelineConfig,
  _deps: PipelineDeps,
): Promise<{ success: boolean; message?: string }> {
  return { success: true };
}

async function runReviewAgent(
  _session: Session,
  _config: PipelineConfig,
  _deps: PipelineDeps,
): Promise<{ success: boolean; message?: string }> {
  return { success: true };
}

async function sendFeedback(
  _session: Session,
  _message: string,
  _deps: PipelineDeps,
): Promise<void> {
  // Will use sessionManager.send() — implemented in Task 8
}

async function awaitCoderFix(
  _session: Session,
  _deps: PipelineDeps,
): Promise<void> {
  // Will poll session status until agent is idle again — implemented in Task 8
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/__tests__/pipeline-manager.test.ts`
Expected: PASS

**Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/core/src/pipeline-manager.ts packages/core/src/__tests__/pipeline-manager.test.ts
git commit -m "feat(pipeline): add pipeline manager skeleton"
```

---

### Task 5: Stage 1 — Automated Checks

**Files:**
- Modify: `packages/core/src/pipeline-manager.ts`
- Test: `packages/core/src/__tests__/pipeline-manager.test.ts`

**Step 1: Write failing test for runChecks**

```typescript
describe("runChecks", () => {
  it("should run check commands in the workspace and return success", async () => {
    // Mock execFileAsync to succeed
    const result = await runChecksExported(session, pipelineConfig, deps);
    expect(result.success).toBe(true);
  });

  it("should return failure with output when a check command fails", async () => {
    // Mock execFileAsync to fail on "pnpm typecheck"
    const result = await runChecksExported(session, pipelineConfig, deps);
    expect(result.success).toBe(false);
    expect(result.message).toContain("typecheck");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/core/src/__tests__/pipeline-manager.test.ts`
Expected: FAIL

**Step 3: Implement runChecks**

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runChecks(
  session: Session,
  config: PipelineConfig,
  deps: PipelineDeps,
): Promise<{ success: boolean; message?: string }> {
  const workspacePath = session.workspacePath;
  if (!workspacePath) {
    return { success: false, message: "No workspace path on session" };
  }

  // Update session status to "checking"
  await updateSessionStatus(session, "checking", deps);

  for (const cmd of config.checkCommands) {
    const [command, ...args] = cmd.split(" ");
    try {
      await execFileAsync(command, args, {
        cwd: workspacePath,
        timeout: 300_000, // 5 min per check
        env: { ...process.env, PATH: process.env["PATH"] },
      });
      console.log(`[PIPELINE] ✓ ${cmd}`);
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      const output = [error.stdout, error.stderr].filter(Boolean).join("\n");
      console.log(`[PIPELINE] ✗ ${cmd}`);
      return {
        success: false,
        message: `Check failed: ${cmd}\n\n${output || error.message || "Unknown error"}`,
      };
    }
  }

  return { success: true };
}

async function updateSessionStatus(
  session: Session,
  status: SessionStatus,
  deps: PipelineDeps,
): Promise<void> {
  const project = deps.config.projects[session.projectId];
  if (!project) return;
  const sessionsDir = getProjectSessionsDir(deps.config, project);
  updateMetadata(sessionsDir, session.id, { status });
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/__tests__/pipeline-manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/pipeline-manager.ts packages/core/src/__tests__/pipeline-manager.test.ts
git commit -m "feat(pipeline): implement automated checks stage"
```

---

### Task 6: Stage 2 — Test Agent

**Files:**
- Modify: `packages/core/src/pipeline-manager.ts`
- Test: `packages/core/src/__tests__/pipeline-manager.test.ts`

**Step 1: Write failing test for runTestAgent**

```typescript
describe("runTestAgent", () => {
  it("should spawn a test agent in the coder workspace and await completion", async () => {
    const mockSpawn = vi.fn().mockResolvedValue({ id: "test-session-1", status: "spawning" });
    deps.sessionManager.spawn = mockSpawn;

    const result = await runTestAgentExported(session, pipelineConfig, deps);

    expect(mockSpawn).toHaveBeenCalledWith(expect.objectContaining({
      projectId: session.projectId,
      workspacePath: session.workspacePath,
      role: "tester",
      parentSession: session.id,
    }));
    expect(result.success).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Expected: FAIL

**Step 3: Implement runTestAgent**

```typescript
async function runTestAgent(
  session: Session,
  config: PipelineConfig,
  deps: PipelineDeps,
): Promise<{ success: boolean; message?: string }> {
  await updateSessionStatus(session, "testing", deps);

  const prompt = await buildTestPrompt(session, config, deps);

  const testSession = await deps.sessionManager.spawn({
    projectId: session.projectId,
    issueId: session.issueId ?? undefined,
    workspacePath: session.workspacePath ?? undefined,
    prompt,
    agent: config.testAgent.agent,
    role: "tester",
    parentSession: session.id,
  });

  // Wait for test agent to finish
  const finalStatus = await awaitSessionTerminal(testSession.id, deps);

  // After test agent exits, run checks again to see if tests pass
  const checksAfter = await runChecks(session, config, deps);
  if (!checksAfter.success) {
    return {
      success: false,
      message: `Test agent committed changes but checks now fail:\n\n${checksAfter.message}`,
    };
  }

  return { success: true };
}

/** Poll session status until terminal. Returns final status. */
async function awaitSessionTerminal(
  sessionId: string,
  deps: PipelineDeps,
  timeoutMs = 600_000, // 10 min
): Promise<SessionStatus> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const session = await deps.sessionManager.get(sessionId);
    if (!session) return "killed";
    if (TERMINAL_STATUSES.has(session.status)) {
      return session.status;
    }
    await sleep(5_000); // Poll every 5 seconds
  }
  return "killed"; // Timed out
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

**Step 4: Create default test prompt builder**

```typescript
async function buildTestPrompt(
  session: Session,
  config: PipelineConfig,
  deps: PipelineDeps,
): Promise<string> {
  // If custom prompt file configured, read it
  if (config.testAgent.promptFile) {
    const project = deps.config.projects[session.projectId];
    if (project) {
      const promptPath = path.join(project.path, config.testAgent.promptFile);
      try {
        return await readFile(promptPath, "utf-8");
      } catch { /* fall through to default */ }
    }
  }

  return `You are a test engineer. Write tests for the changes on this branch.

1. Read the diff against the default branch:
   git diff origin/main...HEAD

2. Identify what changed — new functions, modified behavior, new endpoints, new modules.

3. Write unit tests for:
   - Each new function and method
   - Edge cases and error paths
   - Boundary conditions and invalid inputs

4. Write integration/e2e tests for:
   - New user-facing behavior or API endpoints
   - Workflow changes
   - Component interactions

5. Run all tests to verify they pass:
   pnpm test

6. If any test reveals a bug in the implementation, document it clearly in a comment
   above the failing test assertion.

7. Commit your tests with a descriptive message and exit.

IMPORTANT:
- Do NOT modify the implementation code — only add test files.
- Follow existing test patterns in the codebase.
- Test files should be co-located or in __tests__/ directories following project convention.
- Use the project's existing test framework (vitest).`;
}
```

**Step 5: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/__tests__/pipeline-manager.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/core/src/pipeline-manager.ts packages/core/src/__tests__/pipeline-manager.test.ts
git commit -m "feat(pipeline): implement test agent stage"
```

---

### Task 7: Stage 3 — Review Agent

**Files:**
- Modify: `packages/core/src/pipeline-manager.ts`
- Test: `packages/core/src/__tests__/pipeline-manager.test.ts`

**Step 1: Write failing test for runReviewAgent**

```typescript
describe("runReviewAgent", () => {
  it("should spawn a review agent and parse the verdict", async () => {
    // Mock spawn + terminal + verdict file
    const result = await runReviewAgentExported(session, pipelineConfig, deps);
    expect(result.success).toBe(true);
  });

  it("should return failure when reviewer requests changes", async () => {
    // Mock verdict file with request_changes
    const result = await runReviewAgentExported(session, pipelineConfig, deps);
    expect(result.success).toBe(false);
    expect(result.message).toContain("changes");
  });
});
```

**Step 2: Run test to verify it fails**

Expected: FAIL

**Step 3: Implement runReviewAgent**

```typescript
async function runReviewAgent(
  session: Session,
  config: PipelineConfig,
  deps: PipelineDeps,
): Promise<{ success: boolean; message?: string }> {
  await updateSessionStatus(session, "reviewing", deps);

  const verdictPath = path.join(
    session.workspacePath ?? "/tmp",
    `.ao-review-${session.id}.json`,
  );

  const prompt = await buildReviewPrompt(session, config, verdictPath, deps);

  const reviewSession = await deps.sessionManager.spawn({
    projectId: session.projectId,
    issueId: session.issueId ?? undefined,
    workspacePath: session.workspacePath ?? undefined,
    prompt,
    agent: config.reviewAgent.agent,
    role: "reviewer",
    parentSession: session.id,
  });

  await awaitSessionTerminal(reviewSession.id, deps);

  // Read verdict
  try {
    const raw = await readFile(verdictPath, "utf-8");
    const verdict = JSON.parse(raw) as {
      verdict: "approve" | "request_changes";
      comments?: Array<{ file: string; line?: number; comment: string }>;
      summary?: string;
    };

    // Clean up verdict file
    await unlink(verdictPath).catch(() => {});

    if (verdict.verdict === "approve") {
      return { success: true, message: verdict.summary };
    }

    // Format review comments as feedback
    const feedback = formatReviewFeedback(verdict);
    return { success: false, message: feedback };
  } catch {
    // No verdict file — reviewer may have crashed or not written one
    return {
      success: false,
      message: "Review agent exited without writing a verdict. Retrying.",
    };
  }
}

function formatReviewFeedback(verdict: {
  comments?: Array<{ file: string; line?: number; comment: string }>;
  summary?: string;
}): string {
  const parts: string[] = [];
  if (verdict.summary) {
    parts.push(`Review Summary: ${verdict.summary}`);
  }
  if (verdict.comments?.length) {
    parts.push("\nReview Comments:");
    for (const c of verdict.comments) {
      const loc = c.line ? `${c.file}:${c.line}` : c.file;
      parts.push(`- ${loc}: ${c.comment}`);
    }
  }
  return parts.join("\n");
}
```

**Step 4: Create default review prompt builder**

```typescript
async function buildReviewPrompt(
  session: Session,
  config: PipelineConfig,
  verdictPath: string,
  deps: PipelineDeps,
): Promise<string> {
  if (config.reviewAgent.promptFile) {
    const project = deps.config.projects[session.projectId];
    if (project) {
      const promptPath = path.join(project.path, config.reviewAgent.promptFile);
      try {
        const custom = await readFile(promptPath, "utf-8");
        return custom.replace("{{verdict_path}}", verdictPath);
      } catch { /* fall through */ }
    }
  }

  return `You are a senior code reviewer. Review ALL changes on this branch.

1. Read the full diff against the default branch:
   git diff origin/main...HEAD

2. Read the CLAUDE.md file for project conventions.

3. Review for:
   - **Correctness**: Logic errors, edge cases, off-by-one errors
   - **Security**: Injection vulnerabilities (SQL, shell, XSS), auth issues, OWASP top 10
   - **Error handling**: Are errors caught and handled? Do they propagate correctly?
   - **Code style**: Does it follow project conventions from CLAUDE.md?
   - **Test quality**: Do the tests actually verify the right behavior? Are edge cases covered?
   - **Performance**: N+1 queries, memory leaks, unnecessary allocations
   - **TypeScript**: Proper types (no \`any\`), correct use of \`unknown\`, type guards

4. Write your verdict to this exact file path:
   ${verdictPath}

   Format (JSON):
   {
     "verdict": "approve" or "request_changes",
     "summary": "One paragraph overall assessment",
     "comments": [
       {
         "file": "path/to/file.ts",
         "line": 42,
         "comment": "Specific actionable feedback"
       }
     ]
   }

5. Exit when done. Do NOT modify any code — only write the verdict file.

IMPORTANT:
- Be thorough but practical. Don't nitpick style issues that a linter would catch.
- Focus on issues that could cause bugs, security vulnerabilities, or maintenance problems.
- Every comment should be specific and actionable — not "consider improving" but "this will fail when X is null".
- If the code is clean and well-tested, approve it. Don't request changes for the sake of it.`;
}
```

**Step 5: Run tests**

Run: `pnpm test -- packages/core/src/__tests__/pipeline-manager.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/core/src/pipeline-manager.ts packages/core/src/__tests__/pipeline-manager.test.ts
git commit -m "feat(pipeline): implement review agent stage"
```

---

### Task 8: Implement Feedback Loop and Coder Signaling

**Files:**
- Modify: `packages/core/src/pipeline-manager.ts`
- Test: `packages/core/src/__tests__/pipeline-manager.test.ts`

**Step 1: Write failing test for sendFeedback**

```typescript
describe("sendFeedback", () => {
  it("should send feedback message to the coder session", async () => {
    const mockSend = vi.fn().mockResolvedValue(undefined);
    deps.sessionManager.send = mockSend;

    await sendFeedbackExported(session, "typecheck failed: error TS2345", deps);

    expect(mockSend).toHaveBeenCalledWith(
      session.id,
      expect.stringContaining("typecheck failed"),
    );
  });
});
```

**Step 2: Run test — expect FAIL**

**Step 3: Implement sendFeedback**

```typescript
async function sendFeedback(
  session: Session,
  message: string,
  deps: PipelineDeps,
): Promise<void> {
  const feedbackMessage = `The pre-PR pipeline found issues that need to be fixed:

${message}

Fix the issues and the pipeline will re-run automatically when you're done.`;

  try {
    await deps.sessionManager.send(session.id, feedbackMessage);
  } catch (err: unknown) {
    // If agent has exited, try to restore it
    console.log(`[PIPELINE] Cannot send to ${session.id}, attempting restore`);
    // TODO: Call sessionManager.restore() if available
  }
}
```

**Step 4: Implement awaitCoderFix**

```typescript
async function awaitCoderFix(
  session: Session,
  deps: PipelineDeps,
  timeoutMs = 1_200_000, // 20 min
): Promise<void> {
  const start = Date.now();

  // Wait for agent to process the feedback and become idle again
  // We detect "idle" by watching for the agent to stop producing output
  while (Date.now() - start < timeoutMs) {
    await sleep(10_000); // Check every 10 seconds

    const current = await deps.sessionManager.get(session.id);
    if (!current) return; // Session gone

    // If agent exited, it's done (for better or worse)
    if (TERMINAL_STATUSES.has(current.status)) return;

    // Check if agent is idle (not actively working)
    // This uses the agent's activity detection
    if (current.activity === "idle" || current.activity === "ready") {
      // Give agent a few more seconds in case it's between actions
      await sleep(5_000);
      const recheck = await deps.sessionManager.get(session.id);
      if (recheck && (recheck.activity === "idle" || recheck.activity === "ready")) {
        return; // Agent is done fixing
      }
    }
  }

  console.log(`[PIPELINE] Timed out waiting for coder fix on ${session.id}`);
}
```

**Step 5: Run tests**

Run: `pnpm test -- packages/core/src/__tests__/pipeline-manager.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/core/src/pipeline-manager.ts packages/core/src/__tests__/pipeline-manager.test.ts
git commit -m "feat(pipeline): implement feedback loop and coder signaling"
```

---

### Task 9: Wire Pipeline into Lifecycle Manager

**Files:**
- Modify: `packages/core/src/lifecycle-manager.ts`
- Test: `packages/core/src/__tests__/lifecycle-manager.test.ts`

This is the critical integration. The lifecycle manager needs to detect "coder idle with commits, no PR" and trigger the pipeline.

**Step 1: Add pipeline detection to determineStatus**

In `determineStatus()`, after the agent activity check but before the PR detection (around line 248), add:

```typescript
// Check if coder agent is idle and pipeline should run
if (session.metadata["role"] !== "tester" && session.metadata["role"] !== "reviewer") {
  // Only trigger pipeline for coder sessions
  if (session.status === "working" || oldStatus === "working") {
    // Agent is alive but idle — check for commits with no PR
    if (!session.pr && session.workspacePath && session.branch) {
      const hasCommits = await checkBranchHasCommits(session);
      if (hasCommits && agentIsIdle) {
        return "checking"; // Trigger pipeline
      }
    }
  }
}
```

**Step 2: Add helper to check branch has commits**

```typescript
async function checkBranchHasCommits(session: Session): Promise<boolean> {
  if (!session.workspacePath || !session.branch) return false;
  try {
    const project = config.projects[session.projectId];
    const defaultBranch = project?.defaultBranch ?? "main";
    const { stdout } = await execFileAsync(
      "git",
      ["log", `origin/${defaultBranch}..HEAD`, "--oneline", "--max-count=1"],
      { cwd: session.workspacePath, timeout: 10_000 },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
```

**Step 3: Add pipeline trigger to checkSession**

In `checkSession()`, when status transitions to `"checking"`:

```typescript
if (newStatus === "checking" && pipelineManager && !pipelineManager.isRunning(session.id)) {
  // Fire pipeline in background — don't block the poll loop
  void pipelineManager.run(session).then((result) => {
    if (result.success) {
      console.log(`[PIPELINE] Approved for ${session.id} after ${result.iteration} iterations`);
      // Send approval message to coder
      sessionManager.send(session.id,
        "Your code has been reviewed and approved! Open a PR now."
      ).catch(() => {});
    } else {
      console.log(`[PIPELINE] Failed for ${session.id}: ${result.message}`);
      // Escalate to human
      notifyHuman({
        type: "pipeline.exhausted",
        sessionId: session.id,
        message: result.message,
      });
    }
  }).catch((err: unknown) => {
    console.error(`[PIPELINE] Error for ${session.id}:`, err);
  });
}
```

**Step 4: Add pipeline status event mapping**

In `statusToEventType()`, add:

```typescript
case "checking": return "pipeline.checking";
case "testing": return "pipeline.testing";
case "reviewing": return "pipeline.reviewing";
```

**Step 5: Wire PipelineManager into createLifecycleManager**

Add `pipelineManager` to the deps of `createLifecycleManager()`:

```typescript
export function createLifecycleManager(deps: {
  sessionManager: SessionManager;
  config: OrchestratorConfig;
  registry: PluginRegistry;
  pipelineManager?: PipelineManager; // NEW
}): LifecycleManager {
  const { pipelineManager } = deps;
  // ... existing code, using pipelineManager in checkSession
}
```

**Step 6: Run typecheck + tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

**Step 7: Commit**

```bash
git add packages/core/src/lifecycle-manager.ts packages/core/src/__tests__/lifecycle-manager.test.ts
git commit -m "feat(lifecycle): wire pipeline trigger on idle-with-commits"
```

---

### Task 10: Add Skip Flags

**Files:**
- Modify: `packages/core/src/types.ts` (already done in Task 1)
- Modify: `packages/core/src/session-manager.ts`
- Modify: `packages/web/src/app/api/spawn/route.ts`
- Modify: `packages/cli/src/commands/spawn.ts`

**Step 1: Pass skipPipeline through spawn API**

In `packages/web/src/app/api/spawn/route.ts`, accept `skipPipeline` in the body:

```typescript
const session = await sessionManager.spawn({
  projectId: body.projectId as string,
  issueId: (body.issueId as string) ?? undefined,
  skipPipeline: body.skipPipeline === true,
});
```

**Step 2: Write skipPipeline to metadata**

In `session-manager.ts` spawn(), add to metadata write:

```typescript
writeMetadata(sessionsDir, sessionId, {
  // ... existing fields ...
  skipPipeline: spawnConfig.skipPipeline ? "true" : undefined,
});
```

**Step 3: Check skipPipeline in lifecycle manager**

In the pipeline trigger code (Task 9), add the check:

```typescript
if (newStatus === "checking"
    && pipelineManager
    && !pipelineManager.isRunning(session.id)
    && session.metadata["skipPipeline"] !== "true") {
  // ... trigger pipeline
}
```

**Step 4: Add CLI flag**

In `packages/cli/src/commands/spawn.ts`, add option:

```typescript
.option("--skip-pipeline", "Skip the pre-PR quality pipeline")
.option("--skip-tests", "Skip the test agent stage")
.option("--skip-review", "Skip the review agent stage")
```

**Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/core/src/session-manager.ts packages/web/src/app/api/spawn/route.ts packages/cli/src/commands/spawn.ts
git commit -m "feat(pipeline): add skip flags to spawn API and CLI"
```

---

### Task 11: Default Config and Prompt Templates

**Files:**
- Modify: `agent-orchestrator.yaml`
- Modify: `agent-orchestrator.yaml.example`

**Step 1: Add pipeline section to agent-orchestrator.yaml.example**

```yaml
# Pre-PR quality pipeline
# Runs automated checks, spawns test writer, then code reviewer before any PR opens.
pipeline:
  enabled: true
  checkCommands:
    - pnpm typecheck
    - pnpm lint
    - pnpm test
  testAgent:
    agent: claude-code
    model: opus
    # promptFile: .ao/test-prompt.md  # Optional custom prompt
    maxRetries: 3
  reviewAgent:
    agent: claude-code
    model: opus
    # promptFile: .ao/review-prompt.md  # Optional custom prompt
    maxRetries: 2
  maxIterations: 5
```

**Step 2: Add pipeline section to your actual agent-orchestrator.yaml**

Same as above but with your actual check commands.

**Step 3: Commit**

```bash
git add agent-orchestrator.yaml agent-orchestrator.yaml.example
git commit -m "config: add pipeline section to agent-orchestrator.yaml"
```

---

### Task 12: Export and Wire Everything Together

**Files:**
- Modify: `packages/core/src/index.ts` (export pipeline manager)
- Modify: `packages/core/src/services.ts` or wherever services are composed
- Modify: `packages/web/src/lib/services.ts` (add pipeline manager to service container)

**Step 1: Export from core**

In `packages/core/src/index.ts`, add:

```typescript
export { createPipelineManager } from "./pipeline-manager.js";
export type { PipelineManager, PipelineResult, PipelineDeps } from "./pipeline-manager.js";
```

**Step 2: Create PipelineManager in service initialization**

Wherever `createLifecycleManager` is called (likely in CLI `ao start` or web service init), also create the pipeline manager and pass it in:

```typescript
const pipelineManager = createPipelineManager({
  sessionManager,
  config,
  registry,
});

const lifecycleManager = createLifecycleManager({
  sessionManager,
  config,
  registry,
  pipelineManager,
});
```

**Step 3: Build and typecheck**

Run: `pnpm build && pnpm typecheck`
Expected: PASS

**Step 4: Run all tests**

Run: `pnpm test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/web/src/lib/services.ts
git commit -m "feat(pipeline): wire pipeline manager into service container"
```

---

### Task 13: Integration Test

**Files:**
- Create: `packages/core/src/__tests__/pipeline-integration.test.ts`

**Step 1: Write integration test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { createPipelineManager } from "../pipeline-manager.js";

describe("Pipeline Integration", () => {
  it("should run full pipeline: checks → test → review → approved", async () => {
    const mockSessionManager = {
      spawn: vi.fn().mockResolvedValue({ id: "test-1", status: "spawning" }),
      get: vi.fn()
        .mockResolvedValueOnce({ id: "test-1", status: "killed" }) // test agent done
        .mockResolvedValueOnce({ id: "review-1", status: "killed" }), // review agent done
      send: vi.fn().mockResolvedValue(undefined),
    };

    // ... mock config, registry
    // ... mock verdict file to approve

    const pm = createPipelineManager({ sessionManager: mockSessionManager, config, registry });
    const result = await pm.run(coderSession);

    expect(result.success).toBe(true);
    expect(result.stage).toBe("approved");
    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(2); // test + review
  });

  it("should loop back when checks fail", async () => {
    // Mock first check to fail, second to pass
    // Verify send() called with error message
    // Verify pipeline retries
  });

  it("should escalate after max iterations", async () => {
    // Mock checks to always fail
    // Verify result.success is false after maxIterations
  });

  it("should skip pipeline when disabled", async () => {
    const pm = createPipelineManager({
      ...deps,
      config: { ...config, pipeline: { enabled: false } },
    });
    const result = await pm.run(coderSession);
    expect(result.success).toBe(true);
    expect(result.stage).toBe("approved");
  });
});
```

**Step 2: Run integration tests**

Run: `pnpm test -- packages/core/src/__tests__/pipeline-integration.test.ts`
Expected: PASS

**Step 3: Run full test suite**

Run: `pnpm test`
Expected: ALL PASS

**Step 4: Final commit**

```bash
git add packages/core/src/__tests__/pipeline-integration.test.ts
git commit -m "test(pipeline): add integration tests for full pipeline flow"
```

---

## Verification Checklist

After all tasks complete:

1. `pnpm typecheck` — no errors
2. `pnpm lint` — no errors
3. `pnpm test` — all pass
4. Manual test flow:
   - Spawn a session: `ao spawn dashboard --issue DSH-XXX`
   - Agent codes and goes idle
   - Verify lifecycle detects idle-with-commits
   - Verify automated checks run
   - Verify test agent spawns and writes tests
   - Verify review agent spawns and writes verdict
   - Verify approval message sent to coder
   - Verify coder opens PR
5. Test skip flags: `ao spawn dashboard --skip-pipeline`
6. Test failure loop: introduce a deliberate typecheck error, verify coder gets feedback

## File Summary

| File | Action | Task |
|------|--------|------|
| `packages/core/src/types.ts` | Modify | 1 |
| `packages/core/src/config.ts` | Modify | 2 |
| `packages/core/src/session-manager.ts` | Modify | 3, 10 |
| `packages/core/src/pipeline-manager.ts` | Create | 4, 5, 6, 7, 8 |
| `packages/core/src/lifecycle-manager.ts` | Modify | 9 |
| `packages/core/src/index.ts` | Modify | 12 |
| `packages/web/src/app/api/spawn/route.ts` | Modify | 10 |
| `packages/web/src/lib/services.ts` | Modify | 12 |
| `packages/cli/src/commands/spawn.ts` | Modify | 10 |
| `agent-orchestrator.yaml` | Modify | 11 |
| `agent-orchestrator.yaml.example` | Modify | 11 |
| `packages/core/src/__tests__/pipeline-manager.test.ts` | Create | 4, 5, 6, 7, 8 |
| `packages/core/src/__tests__/pipeline-integration.test.ts` | Create | 13 |
