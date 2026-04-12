# Adversarial Validation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional YAML-configurable feature where a primary agent and a critic agent alternate across phases (plan → critique → refine → implement → critique → refine) within a single AO session, with file-based handoff and fixed-round convergence.

**Architecture:** Two new session statuses (`planning`, `reviewing`) extend the existing state machine. A new `swapAgent()` function in session-manager destroys the current runtime and launches a new one with a different agent, preserving the AO session ID and workspace. The lifecycle polling loop detects idle+artifact signals to advance phases via a `advanceAdversarialPhase()` state-machine table. Prompts are layered on top of the existing 3-layer system via `buildPhasePrompt()`.

**Tech Stack:** TypeScript, Zod (config validation), Vitest (testing), Next.js (web dashboard)

**Spec:** `docs/specs/adversarial-validation.md`

**Improvements over spec** (from Anthropic's "Effective Harnesses for Long-Running Agents"):
- Critic prompts include explicit startup rituals (read git log, read artifacts, then critique)
- `working` phase prompt includes a test checkpoint before implementation
- Agent-written `progress.md` tracks cumulative state across phases
- `round.json` remains orchestrator-managed (JSON = harder for agents to tamper with)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/core/src/types.ts` | Modify | Add `"planning"` + `"reviewing"` to `SessionStatus`; add adversarial metadata fields to `SessionMetadata` |
| `packages/core/src/config.ts` | Modify | Add `adversarialReview` Zod schema to `ProjectConfigSchema` |
| `packages/core/src/prompt-builder.ts` | Modify | Add `buildPhasePrompt()` with per-phase templates including startup rituals |
| `packages/core/src/session-manager.ts` | Modify | Add `swapAgent()`; teach `spawn()` to start in `planning` when adversarial is enabled |
| `packages/core/src/lifecycle-manager.ts` | Modify | Add `advanceAdversarialPhase()` + polling-loop hook for `planning`/`reviewing` statuses |
| `packages/core/src/index.ts` | Modify | Export new `buildPhasePrompt` + `AdversarialPhase` type |
| `packages/web/src/lib/types.ts` | Modify | Add `"planning"` + `"reviewing"` to `SessionStatus` (re-export from core) |
| `packages/web/src/lib/phases.ts` | Modify | Place new statuses in `prePr` lane; add labels + colors |
| `packages/web/src/components/SessionCard.tsx` | Modify | Render adversarial round pill |
| `packages/core/src/__tests__/adversarial-validation.test.ts` | Create | Unit tests for transition table, swapAgent, config parsing, phase prompts |
| `docs/config.md` | Create/Modify | Document the `adversarialReview` YAML config block |

---

## Chunk 1: Types & Config Foundation

### Task 1: Add adversarial types to core

**Files:**
- Modify: `packages/core/src/types.ts:28-45` (SessionStatus)
- Modify: `packages/core/src/types.ts:1362-1383` (SessionMetadata)
- Test: `packages/core/src/__tests__/adversarial-validation.test.ts` (new)

- [ ] **Step 1: Write failing test for new SessionStatus values**

```typescript
// packages/core/src/__tests__/adversarial-validation.test.ts
import { describe, it, expect } from "vitest";
import type { SessionStatus } from "../types.js";

describe("Adversarial Validation — Types", () => {
  it("SessionStatus includes planning and reviewing", () => {
    // Type-level test: these assignments must compile without error
    const planning: SessionStatus = "planning";
    const reviewing: SessionStatus = "reviewing";
    expect(planning).toBe("planning");
    expect(reviewing).toBe("reviewing");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm --filter @aoagents/ao-core test -- --run adversarial-validation`
Expected: FAIL — `Type '"planning"' is not assignable to type 'SessionStatus'`

- [ ] **Step 3: Add `"planning"` and `"reviewing"` to `SessionStatus`**

In `packages/core/src/types.ts:28-45`, add two new members to the union:

```typescript
export type SessionStatus =
  | "spawning"
  | "planning"    // NEW: primary drafting/refining plan
  | "reviewing"   // NEW: critic reviewing plan or code
  | "working"
  | "pr_open"
  | "ci_failed"
  | "review_pending"
  | "changes_requested"
  | "approved"
  | "mergeable"
  | "merged"
  | "cleanup"
  | "needs_input"
  | "stuck"
  | "errored"
  | "killed"
  | "idle"
  | "done"
  | "terminated";
```

- [ ] **Step 4: Add adversarial metadata fields to `SessionMetadata`**

In `packages/core/src/types.ts:1362-1383`, add fields after existing ones:

```typescript
export interface SessionMetadata {
  // ... existing fields ...
  pinnedSummary?: string;
  userPrompt?: string;
  // Adversarial validation fields
  adversarialEnabled?: string;        // "true" | "false" — flat metadata is string-only
  adversarialPrimary?: string;        // Primary agent name (e.g. "claude-code")
  adversarialCritic?: string;         // Critic agent name (e.g. "codex")
  adversarialPhase?: string;          // "plan_review" | "code_review"
  adversarialRound?: string;          // Current round number (stringified)
  adversarialPlanMaxRounds?: string;  // Max plan review rounds (stringified)
  adversarialCodeMaxRounds?: string;  // Max code review rounds (stringified)
}
```

- [ ] **Step 4b: Add `PLANNING` and `REVIEWING` to `SESSION_STATUS` constant object**

In `packages/core/src/types.ts:92-110`, add entries to the `SESSION_STATUS` constant (before `WORKING`):

```typescript
export const SESSION_STATUS = {
  SPAWNING: "spawning" as const,
  PLANNING: "planning" as const,     // NEW
  REVIEWING: "reviewing" as const,   // NEW
  WORKING: "working" as const,
  // ... rest unchanged
} satisfies Record<string, SessionStatus>;
```

This ensures consistency with existing codebase style (lifecycle-manager uses `SESSION_STATUS.X` constants, not string literals).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm --filter @aoagents/ao-core test -- --run adversarial-validation`
Expected: PASS

- [ ] **Step 6: Run typecheck to confirm no regressions**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm typecheck`
Expected: May have failures in switch statements that don't handle the new statuses — note them for later tasks.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/__tests__/adversarial-validation.test.ts
git commit -m "feat(core): add planning and reviewing to SessionStatus for adversarial validation"
```

---

### Task 2: Add `adversarialReview` Zod schema to config

**Files:**
- Modify: `packages/core/src/config.ts:167-194` (ProjectConfigSchema)
- Test: `packages/core/src/__tests__/adversarial-validation.test.ts`

- [ ] **Step 1: Write failing tests for config parsing**

Append to `packages/core/src/__tests__/adversarial-validation.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

// We need to test the Zod schema directly.
// The schema is not exported, so we test via validateConfig or by importing the schema.
// For unit tests, we'll validate the shape by testing a minimal config round-trip.

describe("Adversarial Validation — Config", () => {
  it("accepts valid adversarialReview config", () => {
    const input = {
      adversarialReview: {
        enabled: true,
        critic: { agent: "codex" },
        plan: { enabled: true, maxRounds: 2 },
        code: { enabled: true, maxRounds: 1 },
      },
    };
    // Will test after schema is added — for now just assert shape
    expect(input.adversarialReview.enabled).toBe(true);
    expect(input.adversarialReview.critic.agent).toBe("codex");
  });

  it("defaults adversarialReview to undefined when omitted", () => {
    const input = {};
    expect((input as Record<string, unknown>).adversarialReview).toBeUndefined();
  });

  it("defaults plan.maxRounds to 2 and code.maxRounds to 1", () => {
    const input = {
      adversarialReview: {
        enabled: true,
        critic: { agent: "codex" },
        plan: { enabled: true },
        code: { enabled: true },
      },
    };
    // Defaults will be applied by Zod — test after schema wiring
    expect(input.adversarialReview.plan.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (these are structural for now)**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm --filter @aoagents/ao-core test -- --run adversarial-validation`
Expected: PASS (structural tests)

- [ ] **Step 3: Add Zod schema for `adversarialReview`**

In `packages/core/src/config.ts`, before `ProjectConfigSchema` (around line 165), add:

```typescript
const AdversarialCriticConfigSchema = z.object({
  agent: z.string(),
  agentConfig: AgentSpecificConfigSchema.optional(),
});

const AdversarialPhaseConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxRounds: z.number().int().min(1).default(2),
});

const AdversarialCodePhaseConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxRounds: z.number().int().min(1).default(1),
});

const AdversarialReviewConfigSchema = z.object({
  enabled: z.boolean().default(false),
  critic: AdversarialCriticConfigSchema,
  plan: AdversarialPhaseConfigSchema.optional(),
  code: AdversarialCodePhaseConfigSchema.optional(),
});
```

- [ ] **Step 4: Wire into `ProjectConfigSchema`**

In `packages/core/src/config.ts:167-194`, add to the `ProjectConfigSchema` object:

```typescript
adversarialReview: AdversarialReviewConfigSchema.optional(),
```

Add after the `opencodeIssueSessionStrategy` field (line 193).

- [ ] **Step 5: Export the schema for testing + write real Zod validation tests**

First, add a test-only named export in `packages/core/src/config.ts` (after the schema definition):

```typescript
/** @internal — exported for testing only */
export { AdversarialReviewConfigSchema as _AdversarialReviewConfigSchema };
```

Then replace the structural config tests with real Zod calls:

```typescript
import { _AdversarialReviewConfigSchema as AdversarialReviewConfigSchema } from "../config.js";

describe("Adversarial Validation — Config (Zod)", () => {
  it("accepts valid config and applies defaults", () => {
    const result = AdversarialReviewConfigSchema.safeParse({
      enabled: true,
      critic: { agent: "codex" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plan?.maxRounds).toBe(2);      // default
      expect(result.data.code?.maxRounds).toBe(1);      // default
      expect(result.data.plan?.enabled).toBe(true);      // default
    }
  });

  it("rejects when critic.agent is missing", () => {
    const result = AdversarialReviewConfigSchema.safeParse({
      enabled: true,
      critic: {},  // missing required 'agent'
    });
    expect(result.success).toBe(false);
  });

  it("rejects when maxRounds is 0", () => {
    const result = AdversarialReviewConfigSchema.safeParse({
      enabled: true,
      critic: { agent: "codex" },
      plan: { enabled: true, maxRounds: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("accepts disabled config without critic", () => {
    // When parsed as optional at ProjectConfigSchema level, undefined is valid.
    // At the schema level, critic is still required:
    const result = AdversarialReviewConfigSchema.safeParse({
      enabled: false,
      critic: { agent: "codex" },
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 6: Run typecheck**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm typecheck`
Expected: PASS (new field is optional, no downstream breakage)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/__tests__/adversarial-validation.test.ts
git commit -m "feat(core): add adversarialReview Zod schema to ProjectConfigSchema"
```

---

## Chunk 2: Phase Prompts

### Task 3: Add `buildPhasePrompt()` to prompt-builder

**Files:**
- Modify: `packages/core/src/prompt-builder.ts:1-146`
- Test: `packages/core/src/__tests__/adversarial-validation.test.ts`

- [ ] **Step 1: Write failing tests for phase prompts**

Append to `packages/core/src/__tests__/adversarial-validation.test.ts`:

```typescript
import { buildPhasePrompt } from "../prompt-builder.js";
import type { AdversarialPhaseContext } from "../prompt-builder.js";

describe("Adversarial Validation — Phase Prompts", () => {
  it("planning round 0 instructs to write plan.md and exit", () => {
    const prompt = buildPhasePrompt({
      phase: "planning",
      round: 0,
      maxRounds: 2,
    });
    expect(prompt).toContain(".ao/adversarial/plan.md");
    expect(prompt).toContain("Do not write any code");
    expect(prompt).toContain("Exit when");
  });

  it("planning round > 0 references critique file", () => {
    const prompt = buildPhasePrompt({
      phase: "planning",
      round: 1,
      maxRounds: 2,
    });
    expect(prompt).toContain("plan.critique.md");
    expect(prompt).toContain("revised");
  });

  it("plan_review includes startup ritual", () => {
    const prompt = buildPhasePrompt({
      phase: "plan_review",
      round: 0,
      maxRounds: 2,
    });
    expect(prompt).toContain("git log");
    expect(prompt).toContain("plan.md");
    expect(prompt).toContain("plan.critique.md");
    expect(prompt).toContain("Do not modify");
    expect(prompt).toContain("Exit");
  });

  it("working phase references plan and includes test checkpoint", () => {
    const prompt = buildPhasePrompt({
      phase: "working",
      round: 0,
      maxRounds: 1,
    });
    expect(prompt).toContain("plan.md");
    expect(prompt).toContain("test");
  });

  it("working phase after code review references critique", () => {
    const prompt = buildPhasePrompt({
      phase: "working_after_code_review",
      round: 0,
      maxRounds: 1,
    });
    expect(prompt).toContain("code.critique.md");
  });

  it("code_review includes startup ritual and diff instruction", () => {
    const prompt = buildPhasePrompt({
      phase: "code_review",
      round: 0,
      maxRounds: 1,
    });
    expect(prompt).toContain("git log");
    expect(prompt).toContain("git diff");
    expect(prompt).toContain("code.critique.md");
    expect(prompt).toContain("Do not modify any source");
    expect(prompt).toContain("Exit");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm --filter @aoagents/ao-core test -- --run adversarial-validation`
Expected: FAIL — `buildPhasePrompt` is not exported / does not exist

- [ ] **Step 3: Implement `buildPhasePrompt()`**

Add to `packages/core/src/prompt-builder.ts` after the existing `buildPrompt()` function:

```typescript
// =============================================================================
// ADVERSARIAL PHASE PROMPTS
// =============================================================================

/** Discriminated phase for adversarial prompt generation. */
export type AdversarialPhase =
  | "planning"
  | "plan_review"
  | "working"
  | "working_after_code_review"
  | "code_review";

export interface AdversarialPhaseContext {
  phase: AdversarialPhase;
  round: number;
  maxRounds: number;
}

const ADVERSARIAL_DIR = ".ao/adversarial";

/**
 * Build a phase-specific prompt fragment for adversarial validation.
 * This is appended on top of the existing 3-layer prompt.
 */
export function buildPhasePrompt(ctx: AdversarialPhaseContext): string {
  const { phase, round } = ctx;

  switch (phase) {
    case "planning": {
      const lines = [
        "## Adversarial Validation — Planning Phase",
        "",
        `You are in planning round ${round + 1}/${ctx.maxRounds}.`,
        "",
      ];
      if (round === 0) {
        lines.push(
          "Draft a detailed implementation plan for the task assigned to you.",
          `Write it to \`${ADVERSARIAL_DIR}/plan.md\`.`,
          "The plan should cover: approach, files to modify, edge cases, test strategy.",
          "Do not write any code yet — only the plan.",
          `Update \`${ADVERSARIAL_DIR}/progress.md\` with what you accomplished this phase.`,
          "Exit when the plan is complete.",
        );
      } else {
        lines.push(
          `A critique of your previous plan has been written to \`${ADVERSARIAL_DIR}/plan.critique.md\`.`,
          "Read it carefully and produce a revised plan that addresses the feedback.",
          `Write the revised plan to \`${ADVERSARIAL_DIR}/plan.md\` (overwrite the previous version).`,
          "Do not write any code yet — only the revised plan.",
          `Update \`${ADVERSARIAL_DIR}/progress.md\` with what you changed and why.`,
          "Exit when the revised plan is complete.",
        );
      }
      return lines.join("\n");
    }

    case "plan_review": {
      return [
        "## Adversarial Validation — Plan Review",
        "",
        "You are an adversarial reviewer. Your job is to find problems before code is written.",
        "",
        "**Startup: orient yourself before reviewing.**",
        "1. Run `git log --oneline -20` to understand recent history.",
        `2. Read \`${ADVERSARIAL_DIR}/plan.md\` thoroughly.`,
        "3. If an issue description exists, read it for requirements context.",
        "",
        "**Then write your critique:**",
        `Write a structured critique to \`${ADVERSARIAL_DIR}/plan.critique.md\` covering:`,
        "- Missing requirements or acceptance criteria",
        "- Risky assumptions",
        "- Simpler alternatives the author may have overlooked",
        "- Test gaps",
        "- Potential integration issues",
        "",
        "Be concrete and actionable — cite specific sections of the plan.",
        `Do not modify \`${ADVERSARIAL_DIR}/plan.md\` or any source files.`,
        `Update \`${ADVERSARIAL_DIR}/progress.md\` with a one-line summary of your review.`,
        "Exit when your critique is complete.",
      ].join("\n");
    }

    case "working": {
      return [
        "## Adversarial Validation — Implementation Phase",
        "",
        `Follow the plan in \`${ADVERSARIAL_DIR}/plan.md\`.`,
        "",
        "**Before writing code, run the existing test suite** to establish a baseline.",
        "Note any pre-existing failures so you don't waste time on them.",
        "",
        "Implement the plan incrementally — commit after each logical unit of work.",
        `Update \`${ADVERSARIAL_DIR}/progress.md\` as you complete each section.`,
        "When implementation is complete, open a PR (or let the orchestrator detect your commits).",
      ].join("\n");
    }

    case "working_after_code_review": {
      return [
        "## Adversarial Validation — Post-Review Refinement",
        "",
        `A code review has been written to \`${ADVERSARIAL_DIR}/code.critique.md\`.`,
        "Read it carefully and apply the fixes.",
        "",
        "**Before making changes, run the existing test suite** to confirm current state.",
        "",
        "Address each item in the critique. Skip items you disagree with, but document why",
        `in \`${ADVERSARIAL_DIR}/progress.md\`.`,
        "Commit after each fix.",
      ].join("\n");
    }

    case "code_review": {
      return [
        "## Adversarial Validation — Code Review",
        "",
        "You are an adversarial code reviewer. Find bugs before they ship.",
        "",
        "**Startup: orient yourself before reviewing.**",
        "1. Run `git log --oneline -20` to understand what was done.",
        "2. Run `git diff main...HEAD` to see all changes.",
        `3. Read \`${ADVERSARIAL_DIR}/plan.md\` for intended design.`,
        `4. Read \`${ADVERSARIAL_DIR}/progress.md\` for implementation notes.`,
        "",
        "**Then write your critique:**",
        `Write to \`${ADVERSARIAL_DIR}/code.critique.md\` covering:`,
        "- Bugs and logic errors",
        "- Security issues (injection, XSS, auth bypass)",
        "- Test coverage gaps",
        `- Deviations from \`${ADVERSARIAL_DIR}/plan.md\``,
        "- Performance concerns",
        "",
        "Be concrete — cite file paths and line numbers.",
        "Do not modify any source files.",
        `Update \`${ADVERSARIAL_DIR}/progress.md\` with a one-line summary of your review.`,
        "Exit when your review is complete.",
      ].join("\n");
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm --filter @aoagents/ao-core test -- --run adversarial-validation`
Expected: PASS

- [ ] **Step 5: Export from core index**

In `packages/core/src/index.ts`, update the prompt-builder export (around line 65):

```typescript
// Prompt builder — layered prompt composition
export { buildPrompt, buildPhasePrompt } from "./prompt-builder.js";
export type { PromptBuildConfig, AdversarialPhase, AdversarialPhaseContext } from "./prompt-builder.js";
```

- [ ] **Step 6: Run typecheck**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/prompt-builder.ts packages/core/src/index.ts packages/core/src/__tests__/adversarial-validation.test.ts
git commit -m "feat(core): add buildPhasePrompt with per-phase templates and startup rituals"
```

---

## Chunk 3: Agent Swap in Session Manager

### Task 4: Add `swapAgent()` to session-manager

**Files:**
- Modify: `packages/core/src/session-manager.ts`
- Test: `packages/core/src/__tests__/adversarial-validation.test.ts`

- [ ] **Step 1: Write failing tests for `swapAgent()` that actually call the function**

These tests use mocked plugins to test `swapAgent` end-to-end — they verify runtime destroy, agent launch, and metadata updates. They will fail before `swapAgent` is implemented.

Append to `packages/core/src/__tests__/adversarial-validation.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createMockPlugins,
  createMockRegistry,
  setupTestContext,
  teardownTestContext,
} from "./test-utils.js";
import type { TestContext } from "./test-utils.js";
import { writeMetadata, readMetadataRaw } from "../metadata.js";
import { createSessionManager } from "../session-manager.js";

describe("Adversarial Validation — swapAgent", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTestContext();
  });

  afterEach(() => {
    teardownTestContext(ctx);
  });

  it("calls runtime.destroy then runtime.create with new agent", async () => {
    // Pre-populate metadata for an existing planning session
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: ctx.tmpDir,
      branch: "feat/test",
      status: "planning",
      agent: "mock-agent",
      project: "my-app",
      runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "mock", data: {} }),
      adversarialEnabled: "true",
      adversarialPrimary: "mock-agent",
      adversarialCritic: "mock-agent",
      adversarialRound: "0",
    });

    const sm = createSessionManager({
      config: ctx.config,
      registry: ctx.mockRegistry,
    });

    await sm.swapAgent("app-1", "my-app", "mock-agent", {
      resume: false,
      phasePrompt: "Review the plan.",
      newStatus: "reviewing",
      metadataUpdates: { adversarialPhase: "plan_review" },
    });

    // Verify runtime was destroyed then re-created
    expect(ctx.mockRuntime.destroy).toHaveBeenCalledTimes(1);
    expect(ctx.mockRuntime.create).toHaveBeenCalledTimes(1);

    // Verify metadata was updated
    const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(meta!.status).toBe("reviewing");
    expect(meta!.adversarialPhase).toBe("plan_review");
    // sessionId and workspacePath preserved
    expect(meta!.worktree).toBe(ctx.tmpDir);
  });

  it("preserves sessionId and workspacePath across swap", async () => {
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: ctx.tmpDir,
      branch: "feat/test",
      status: "planning",
      agent: "mock-agent",
      project: "my-app",
      runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "mock", data: {} }),
      adversarialEnabled: "true",
      adversarialPrimary: "mock-agent",
      adversarialCritic: "mock-agent",
      adversarialRound: "0",
    });

    const sm = createSessionManager({
      config: ctx.config,
      registry: ctx.mockRegistry,
    });

    await sm.swapAgent("app-1", "my-app", "mock-agent", {
      resume: false,
      phasePrompt: "Review the plan.",
      newStatus: "reviewing",
      metadataUpdates: { adversarialPhase: "plan_review", adversarialRound: "0" },
    });

    const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(meta!.worktree).toBe(ctx.tmpDir);
    expect(meta!.branch).toBe("feat/test");
  });

  it("bumps round in metadata when metadataUpdates includes it", async () => {
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: ctx.tmpDir,
      branch: "feat/test",
      status: "reviewing",
      agent: "mock-agent",
      project: "my-app",
      runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "mock", data: {} }),
      adversarialEnabled: "true",
      adversarialPrimary: "mock-agent",
      adversarialCritic: "mock-agent",
      adversarialRound: "0",
    });

    const sm = createSessionManager({
      config: ctx.config,
      registry: ctx.mockRegistry,
    });

    await sm.swapAgent("app-1", "my-app", "mock-agent", {
      resume: true,
      phasePrompt: "Revise your plan.",
      newStatus: "planning",
      metadataUpdates: { adversarialRound: "1" },
    });

    const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(meta!.adversarialRound).toBe("1");
    expect(meta!.agent).toBe("mock-agent");
    expect(meta!.status).toBe("planning");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm --filter @aoagents/ao-core test -- --run adversarial-validation`
Expected: FAIL — `sm.swapAgent is not a function` (method doesn't exist yet)

- [ ] **Step 3: Implement `swapAgent()` in session-manager**

Add the following function inside `createSessionManager()` in `packages/core/src/session-manager.ts`, after the `spawn()` function (around line 1210). This function will be internal (not on the `SessionManager` interface) — called by the lifecycle manager:

```typescript
/**
 * Swap the running agent within an adversarial validation session.
 * Destroys the current runtime, launches a new one with a different agent,
 * preserving sessionId, workspacePath, and branch.
 */
async function swapAgent(
  sessionId: SessionId,
  projectId: string,
  nextAgent: string,
  opts: {
    resume: boolean;
    phasePrompt: string;
    newStatus: SessionStatus;
    metadataUpdates: Record<string, string | undefined>;
  },
): Promise<void> {
  const project = config.projects[projectId];
  if (!project) throw new Error(`Unknown project: ${projectId}`);

  const sessionsDir = getProjectSessionsDir(project);
  const meta = readMetadataRaw(sessionsDir, sessionId);
  if (!meta) throw new Error(`Session metadata not found: ${sessionId}`);

  const workspacePath = meta.worktree;
  if (!workspacePath) throw new Error(`No workspace path for session: ${sessionId}`);

  // 1. Destroy current runtime
  const runtimeName = project.runtime ?? config.defaults.runtime;
  const runtime = registry.get<Runtime>("runtime", runtimeName);
  if (runtime && meta.runtimeHandle) {
    try {
      const handle = JSON.parse(meta.runtimeHandle) as RuntimeHandle;
      await runtime.destroy(handle);
    } catch {
      // Best effort — runtime may already be dead
    }
  }

  // 2. Rotate activity log to prevent stale entries from leaking across agents
  try {
    const activityPath = join(workspacePath, ".ao", "activity.jsonl");
    const previousAgent = meta.agent ?? "unknown";
    const rotatedPath = join(workspacePath, ".ao", `activity.${previousAgent}.jsonl`);
    const { renameSync, existsSync } = await import("node:fs");
    if (existsSync(activityPath)) {
      renameSync(activityPath, rotatedPath);
    }
  } catch {
    // Non-fatal — stale activity is a minor issue
  }

  // 3. Resolve next agent
  const selection = resolveAgentSelection({
    role: "worker",
    project,
    defaults: config.defaults,
    spawnAgentOverride: nextAgent,
  });
  const agent = registry.get<Agent>("agent", selection.agentName);
  if (!agent) throw new Error(`Agent plugin '${selection.agentName}' not found`);

  // 4. Build prompt: existing layers + phase prompt
  const composedPrompt = buildPrompt({
    loader: getPromptLoader(project.path),
    project,
    projectId,
    issueId: meta.issue,
    userPrompt: opts.phasePrompt,
  });

  // 5. Determine launch or restore command
  const isPrimary = meta.adversarialPrimary === nextAgent;
  let launchCommand: string;

  if (opts.resume && isPrimary && agent.getRestoreCommand) {
    // Try to resume the primary's conversation
    const session = await get(sessionId);
    if (session) {
      const restoreCmd = await agent.getRestoreCommand(session, project);
      if (restoreCmd) {
        launchCommand = restoreCmd;
      } else {
        // Fall back to fresh launch
        launchCommand = agent.getLaunchCommand({
          sessionId,
          projectConfig: { ...project, agentConfig: selection.agentConfig },
          issueId: meta.issue,
          prompt: composedPrompt,
          permissions: selection.permissions,
          model: selection.model,
        });
      }
    } else {
      launchCommand = agent.getLaunchCommand({
        sessionId,
        projectConfig: { ...project, agentConfig: selection.agentConfig },
        issueId: meta.issue,
        prompt: composedPrompt,
        permissions: selection.permissions,
        model: selection.model,
      });
    }
  } else {
    launchCommand = agent.getLaunchCommand({
      sessionId,
      projectConfig: { ...project, agentConfig: selection.agentConfig },
      issueId: meta.issue,
      prompt: composedPrompt,
      permissions: selection.permissions,
      model: selection.model,
    });
  }

  const environment = agent.getEnvironment({
    sessionId,
    projectConfig: { ...project, agentConfig: selection.agentConfig },
    issueId: meta.issue,
    prompt: composedPrompt,
    permissions: selection.permissions,
    model: selection.model,
  });

  // 6. Launch new runtime
  const tmuxName = meta.tmuxName ?? sessionId;
  const handle = await runtime!.create({
    sessionId: tmuxName,
    workspacePath,
    launchCommand,
    environment: {
      ...environment,
      AO_SESSION: sessionId,
      AO_DATA_DIR: sessionsDir,
      AO_SESSION_NAME: sessionId,
      ...(meta.tmuxName && { AO_TMUX_NAME: meta.tmuxName }),
      AO_CALLER_TYPE: "agent",
      AO_PROJECT_ID: projectId,
      AO_CONFIG_PATH: config.configPath,
      ...(config.port !== undefined && config.port !== null && { AO_PORT: String(config.port) }),
    },
  });

  // 7. Post-launch: deliver prompt if needed, setup hooks
  if (agent.promptDelivery === "post-launch" && runtime) {
    await runtime.sendMessage(handle, composedPrompt);
  }

  if (agent.postLaunchSetup) {
    const session = {
      id: sessionId,
      projectId,
      status: opts.newStatus,
      activity: "active" as const,
      branch: meta.branch,
      issueId: meta.issue ?? null,
      pr: null,
      workspacePath,
      runtimeHandle: handle,
      agentInfo: null,
      createdAt: new Date(meta.createdAt ?? Date.now()),
      lastActivityAt: new Date(),
      metadata: { ...meta, ...opts.metadataUpdates },
    };
    await agent.postLaunchSetup(session);
  }

  // 8. Update metadata
  updateMetadata(sessionsDir, sessionId, {
    agent: selection.agentName,
    runtimeHandle: JSON.stringify(handle),
    status: opts.newStatus,
    ...opts.metadataUpdates,
  });
}
```

- [ ] **Step 3b: Expose `swapAgent` to the lifecycle manager**

The lifecycle manager's `LifecycleManagerDeps` types `sessionManager` as the `SessionManager` interface (`packages/core/src/types.ts:1390`). Add `swapAgent` to the interface:

In `packages/core/src/types.ts:1390-1403`, add to `SessionManager`:

```typescript
export interface SessionManager {
  // ... existing methods ...
  claimPR(sessionId: SessionId, prRef: string, options?: ClaimPROptions): Promise<ClaimPRResult>;
  /** Swap the running agent in an adversarial validation session. */
  swapAgent(
    sessionId: SessionId,
    projectId: string,
    nextAgent: string,
    opts: {
      resume: boolean;
      phasePrompt: string;
      newStatus: SessionStatus;
      metadataUpdates: Record<string, string | undefined>;
    },
  ): Promise<void>;
}
```

Then add `swapAgent` to the return object of `createSessionManager()` (alongside `spawn`, `restore`, etc.).

- [ ] **Step 4: Teach `spawn()` to start in `planning` when adversarial is enabled**

In `packages/core/src/session-manager.ts`, in the `spawn()` function around line 1158-1162, modify the initial status:

```typescript
// Determine initial status based on adversarial config
const adversarial = project.adversarialReview;
const isAdversarial = adversarial?.enabled && adversarial.plan?.enabled !== false;
const initialStatus: SessionStatus = isAdversarial ? "planning" : "spawning";
```

Use `initialStatus` instead of `"spawning"` in the session object (line 1161) and the `writeMetadata` call (line 1181).

When adversarial is enabled, also write the adversarial metadata fields:

```typescript
// In writeMetadata call, add:
...(isAdversarial && adversarial ? {
  adversarialEnabled: "true",
  adversarialPrimary: selection.agentName,
  adversarialCritic: adversarial.critic.agent,
  adversarialRound: "0",
  adversarialPlanMaxRounds: String(adversarial.plan?.maxRounds ?? 2),
  adversarialCodeMaxRounds: String(adversarial.code?.maxRounds ?? 1),
} : {}),
```

Also, when adversarial is enabled, append the planning phase prompt to the composed prompt:

```typescript
// After buildPrompt() call, before agentLaunchConfig:
if (isAdversarial) {
  const phasePrompt = buildPhasePrompt({ phase: "planning", round: 0, maxRounds: adversarial!.plan?.maxRounds ?? 2 });
  composedPrompt = composedPrompt + "\n\n" + phasePrompt;
}
```

(Note: `composedPrompt` needs to be `let` instead of `const` for this.)

- [ ] **Step 5: Run tests**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm --filter @aoagents/ao-core test -- --run adversarial-validation`
Expected: PASS

- [ ] **Step 6: Run typecheck**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/session-manager.ts packages/core/src/__tests__/adversarial-validation.test.ts
git commit -m "feat(core): add swapAgent and adversarial-aware spawn to session-manager"
```

---

## Chunk 4: Lifecycle Manager — Phase Advancement

### Task 5: Add `advanceAdversarialPhase()` and polling hook

**Files:**
- Modify: `packages/core/src/lifecycle-manager.ts`
- Test: `packages/core/src/__tests__/adversarial-validation.test.ts`

- [ ] **Step 1: Write failing tests for the state-machine transition table**

Append to `packages/core/src/__tests__/adversarial-validation.test.ts`:

```typescript
describe("Adversarial Validation — Phase Transitions", () => {
  // Test the pure transition logic (no runtime calls)

  interface TransitionInput {
    status: SessionStatus;
    adversarialPhase?: string;
    round: number;
    maxPlanRounds: number;
    maxCodeRounds: number;
    artifactExists: boolean;
  }

  interface TransitionOutput {
    nextStatus: SessionStatus;
    nextPhase?: string;
    swapTo: "primary" | "critic";
    resume: boolean;
    bumpRound: boolean;
  }

  // This function will be extracted as a pure helper for testability.
  // For now, define the expected transitions.

  const cases: Array<{ input: TransitionInput; expected: TransitionOutput | "stuck" }> = [
    {
      input: { status: "planning", round: 0, maxPlanRounds: 2, maxCodeRounds: 1, artifactExists: true },
      expected: { nextStatus: "reviewing", nextPhase: "plan_review", swapTo: "critic", resume: false, bumpRound: false },
    },
    {
      input: { status: "planning", round: 0, maxPlanRounds: 2, maxCodeRounds: 1, artifactExists: false },
      expected: "stuck",
    },
    {
      input: { status: "reviewing", adversarialPhase: "plan_review", round: 0, maxPlanRounds: 2, maxCodeRounds: 1, artifactExists: true },
      expected: { nextStatus: "planning", swapTo: "primary", resume: true, bumpRound: true },
    },
    {
      input: { status: "reviewing", adversarialPhase: "plan_review", round: 1, maxPlanRounds: 2, maxCodeRounds: 1, artifactExists: true },
      expected: { nextStatus: "working", swapTo: "primary", resume: true, bumpRound: false },
    },
    {
      input: { status: "reviewing", adversarialPhase: "code_review", round: 0, maxPlanRounds: 2, maxCodeRounds: 1, artifactExists: true },
      expected: { nextStatus: "working", swapTo: "primary", resume: true, bumpRound: false },
    },
  ];

  it.each(cases)("transition: $input.status (phase=$input.adversarialPhase, round=$input.round, artifact=$input.artifactExists)", ({ input, expected }) => {
    // Will be tested against the extracted function once implemented
    expect(expected).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test (structural, will pass)**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm --filter @aoagents/ao-core test -- --run adversarial-validation`
Expected: PASS (structural assertions)

- [ ] **Step 3: Implement `advanceAdversarialPhase()` as a pure function**

Add to `packages/core/src/lifecycle-manager.ts`, inside the `createLifecycleManager` closure, before the `determineStatus` function:

```typescript
// -----------------------------------------------------------------------
// Adversarial validation — phase advancement
// -----------------------------------------------------------------------

interface AdversarialTransition {
  nextStatus: SessionStatus;
  nextPhase?: string;          // "plan_review" | "code_review"
  swapTo: "primary" | "critic";
  resume: boolean;
  bumpRound: boolean;
  promptPhase: AdversarialPhase;
}

function computeAdversarialTransition(
  status: SessionStatus,
  phase: string | undefined,
  round: number,
  maxPlanRounds: number,
  maxCodeRounds: number,
  artifactExists: boolean,
): AdversarialTransition | "stuck" | null {
  if (status === "planning") {
    if (!artifactExists) return "stuck";
    // Plan written — round check is 0-indexed: round 0 means first plan done
    if (round + 1 < maxPlanRounds) {
      return {
        nextStatus: "reviewing",
        nextPhase: "plan_review",
        swapTo: "critic",
        resume: false,
        bumpRound: false,
        promptPhase: "plan_review",
      };
    }
    // Last plan round — skip to working
    return {
      nextStatus: "working",
      swapTo: "primary",
      resume: true,
      bumpRound: false,
      promptPhase: "working",
    };
  }

  if (status === "reviewing" && phase === "plan_review") {
    if (!artifactExists) return "stuck";
    if (round + 1 < maxPlanRounds) {
      return {
        nextStatus: "planning",
        swapTo: "primary",
        resume: true,
        bumpRound: true,
        promptPhase: "planning",
      };
    }
    // Max plan rounds reached — move to working
    return {
      nextStatus: "working",
      swapTo: "primary",
      resume: true,
      bumpRound: false,
      promptPhase: "working",
    };
  }

  if (status === "reviewing" && phase === "code_review") {
    if (!artifactExists) return "stuck";
    if (round + 1 < maxCodeRounds) {
      return {
        nextStatus: "working",
        swapTo: "primary",
        resume: true,
        bumpRound: true,
        promptPhase: "working_after_code_review",
      };
    }
    // Max code rounds — proceed to normal flow (PR open)
    return {
      nextStatus: "working",
      swapTo: "primary",
      resume: true,
      bumpRound: false,
      promptPhase: "working_after_code_review",
    };
  }

  // "working" → "reviewing" (code_review) is detected differently:
  // when the primary goes idle with commits, the lifecycle manager
  // checks if code review is enabled and swaps to critic.
  // That logic lives in the polling hook, not here.

  return null; // Not an adversarial transition
}
```

- [ ] **Step 4: Add the polling-loop hook for adversarial statuses**

In `packages/core/src/lifecycle-manager.ts`, in the `determineStatus()` function, add a check early (after line 390, before the runtime alive check):

```typescript
// 0. Adversarial phase advancement — if session is in planning/reviewing
//    and the agent has gone idle with the expected artifact, advance phase.
//    IMPORTANT: Return early for active agents to skip unnecessary PR/stuck checks.
if (
  (session.status === "planning" || session.status === "reviewing") &&
  session.metadata["adversarialEnabled"] === "true"
) {
  if (agent) {
    const activityState = await agent.getActivityState(session, config.readyThresholdMs);

    // Agent still working — return current status early.
    // Planning/reviewing sessions can't have PRs, so skip all downstream checks.
    if (!activityState || activityState.state === "active") {
      return session.status;
    }

    if (activityState.state === "waiting_input") return "needs_input";
    if (activityState.state === "exited") return "killed";

    if (activityState.state === "idle" || activityState.state === "ready") {
      // Check for expected artifact
      const { existsSync } = await import("node:fs");
      const adversarialDir = join(session.workspacePath ?? "", ".ao", "adversarial");
      const phase = session.metadata["adversarialPhase"];
      let artifactExists = false;

      if (session.status === "planning") {
        artifactExists = existsSync(join(adversarialDir, "plan.md"));
      } else if (phase === "plan_review") {
        artifactExists = existsSync(join(adversarialDir, "plan.critique.md"));
      } else if (phase === "code_review") {
        artifactExists = existsSync(join(adversarialDir, "code.critique.md"));
      }

      const round = parseInt(session.metadata["adversarialRound"] ?? "0", 10);
      const maxPlanRounds = parseInt(session.metadata["adversarialPlanMaxRounds"] ?? "2", 10);
      const maxCodeRounds = parseInt(session.metadata["adversarialCodeMaxRounds"] ?? "1", 10);

      const transition = computeAdversarialTransition(
        session.status, phase, round, maxPlanRounds, maxCodeRounds, artifactExists,
      );

      if (transition === "stuck") {
        return "stuck";
      }

      if (transition) {
        const primaryAgent = session.metadata["adversarialPrimary"] ?? "";
        const criticAgent = session.metadata["adversarialCritic"] ?? "";
        const nextAgent = transition.swapTo === "primary" ? primaryAgent : criticAgent;
        const newRound = transition.bumpRound ? round + 1 : round;

        try {
          await sessionManager.swapAgent(session.id, session.projectId, nextAgent, {
            resume: transition.resume,
            phasePrompt: buildPhasePrompt({
              phase: transition.promptPhase,
              round: newRound,
              maxRounds: transition.promptPhase.includes("code") ? maxCodeRounds : maxPlanRounds,
            }),
            newStatus: transition.nextStatus,
            metadataUpdates: {
              adversarialRound: String(newRound),
              ...(transition.nextPhase ? { adversarialPhase: transition.nextPhase } : {}),
            },
          });
        } catch (err) {
          // Swap failed — mark as stuck
          return "stuck";
        }

        return transition.nextStatus;
      }
    }

    // Agent is idle/ready but no transition fired — fall through to stuck detection
    // but still return early to skip PR checks (planning/reviewing can't have PRs)
    return session.status;
  }

  return session.status; // No agent plugin — preserve status
}
```

Also, for the `working` → `code_review` transition (when primary finishes implementation), add in the same function after the activity detection block (around line 460), before the PR auto-detect:

```typescript
// 2b. Adversarial code review trigger: if working + adversarial + idle + has commits.
// Guard: only trigger if we haven't already done code review. We use a dedicated
// metadata flag "adversarialCodeReviewDone" because adversarialPhase gets cleared
// when returning from code_review to working, and we must not re-trigger.
if (
  session.status === "working" &&
  session.metadata["adversarialEnabled"] === "true" &&
  session.metadata["adversarialCodeReviewDone"] !== "true" &&
  detectedIdleTimestamp
) {
  const codeReviewEnabled = session.metadata["adversarialCodeMaxRounds"] !== "0";
  if (codeReviewEnabled && !session.pr) {
    // Agent finished working without opening PR — trigger code review
    const criticAgent = session.metadata["adversarialCritic"] ?? "";
    const codeMaxRounds = parseInt(session.metadata["adversarialCodeMaxRounds"] ?? "1", 10);
    try {
      await sessionManager.swapAgent(session.id, session.projectId, criticAgent, {
        resume: false,
        phasePrompt: buildPhasePrompt({ phase: "code_review", round: 0, maxRounds: codeMaxRounds }),
        newStatus: "reviewing",
        metadataUpdates: {
          adversarialPhase: "code_review",
          adversarialRound: "0",
          adversarialCodeReviewDone: "true",  // Prevent re-triggering after refine
        },
      });
      return "reviewing";
    } catch {
      // Non-fatal — continue normal flow
    }
  }
}
```

- [ ] **Step 5: Update the transition table tests to use the real function**

Update the tests to import and test `computeAdversarialTransition` directly. Export it from the lifecycle manager module for testing:

```typescript
// In lifecycle-manager.ts, export the pure function:
export { computeAdversarialTransition };
// (or export it from the module scope, outside createLifecycleManager)
```

Update tests:

```typescript
import { computeAdversarialTransition } from "../lifecycle-manager.js";

describe("Adversarial Validation — computeAdversarialTransition", () => {
  it("planning + artifact → reviewing (plan_review) when rounds remain", () => {
    const result = computeAdversarialTransition("planning", undefined, 0, 2, 1, true);
    expect(result).not.toBe("stuck");
    expect(result).not.toBeNull();
    if (result && result !== "stuck") {
      expect(result.nextStatus).toBe("reviewing");
      expect(result.nextPhase).toBe("plan_review");
      expect(result.swapTo).toBe("critic");
    }
  });

  it("planning + no artifact → stuck", () => {
    const result = computeAdversarialTransition("planning", undefined, 0, 2, 1, false);
    expect(result).toBe("stuck");
  });

  it("planning + artifact + last round → working (skip review)", () => {
    const result = computeAdversarialTransition("planning", undefined, 1, 2, 1, true);
    expect(result).not.toBe("stuck");
    expect(result).not.toBeNull();
    if (result && result !== "stuck") {
      expect(result.nextStatus).toBe("working");
      expect(result.swapTo).toBe("primary");
      expect(result.resume).toBe(true);
    }
  });

  it("reviewing (plan_review) + artifact + rounds remain → planning (bump round)", () => {
    const result = computeAdversarialTransition("reviewing", "plan_review", 0, 2, 1, true);
    expect(result).not.toBe("stuck");
    expect(result).not.toBeNull();
    if (result && result !== "stuck") {
      expect(result.nextStatus).toBe("planning");
      expect(result.swapTo).toBe("primary");
      expect(result.bumpRound).toBe(true);
    }
  });

  it("reviewing (plan_review) + artifact + last round → working", () => {
    const result = computeAdversarialTransition("reviewing", "plan_review", 1, 2, 1, true);
    expect(result).not.toBe("stuck");
    expect(result).not.toBeNull();
    if (result && result !== "stuck") {
      expect(result.nextStatus).toBe("working");
      expect(result.swapTo).toBe("primary");
      expect(result.resume).toBe(true);
    }
  });

  it("reviewing (code_review) + artifact → working (primary resumes)", () => {
    const result = computeAdversarialTransition("reviewing", "code_review", 0, 2, 1, true);
    expect(result).not.toBe("stuck");
    expect(result).not.toBeNull();
    if (result && result !== "stuck") {
      expect(result.nextStatus).toBe("working");
      expect(result.swapTo).toBe("primary");
      expect(result.promptPhase).toBe("working_after_code_review");
    }
  });

  it("reviewing (plan_review) + no artifact → stuck", () => {
    const result = computeAdversarialTransition("reviewing", "plan_review", 0, 2, 1, false);
    expect(result).toBe("stuck");
  });

  it("reviewing (code_review) + no artifact → stuck", () => {
    const result = computeAdversarialTransition("reviewing", "code_review", 0, 2, 1, false);
    expect(result).toBe("stuck");
  });

  it("reviewing (code_review) + artifact + rounds remain → working (bump round)", () => {
    const result = computeAdversarialTransition("reviewing", "code_review", 0, 2, 2, true);
    expect(result).not.toBe("stuck");
    expect(result).not.toBeNull();
    if (result && result !== "stuck") {
      expect(result.nextStatus).toBe("working");
      expect(result.swapTo).toBe("primary");
      expect(result.bumpRound).toBe(true);
      expect(result.promptPhase).toBe("working_after_code_review");
    }
  });

  it("non-adversarial status returns null", () => {
    const result = computeAdversarialTransition("working", undefined, 0, 2, 1, true);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 6: Run tests**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm --filter @aoagents/ao-core test -- --run adversarial-validation`
Expected: PASS

- [ ] **Step 7: Run typecheck**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm typecheck`
Expected: May fail on exhaustive switch statements that don't handle `"planning"` and `"reviewing"` — fix in next task.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/lifecycle-manager.ts packages/core/src/__tests__/adversarial-validation.test.ts
git commit -m "feat(core): add adversarial phase advancement to lifecycle manager"
```

---

## Chunk 5: Web UI — Phases, Labels, SessionCard

### Task 6: Update web types and phases for new statuses

**Files:**
- Modify: `packages/web/src/lib/types.ts`
- Modify: `packages/web/src/lib/phases.ts`

- [ ] **Step 1: Add `"planning"` and `"reviewing"` to web `SessionStatus`**

In `packages/web/src/lib/types.ts`, the `SessionStatus` type is re-exported from core. Verify it picks up the new values automatically. If it's a separate definition, add the new members.

Check the import — if it's `export type { SessionStatus } from "@aoagents/ao-core"`, no change needed. If it's a standalone type, add `"planning" | "reviewing"`.

- [ ] **Step 2: Add new statuses to `PHASE_LANES` prePr lane**

In `packages/web/src/lib/phases.ts:14-17`, update the `prePr` lane:

```typescript
{
  id: "prePr",
  label: "Pre-PR",
  description: "Agent is working, no PR yet",
  statuses: ["spawning", "planning", "reviewing", "working"],
},
```

- [ ] **Step 3: Add labels for new statuses**

In `packages/web/src/lib/phases.ts:47-65`, add entries:

```typescript
export const PHASE_LABELS: Record<SessionStatus, string> = {
  spawning: "Spawning",
  planning: "Planning",     // NEW
  reviewing: "Reviewing",   // NEW
  working: "Working",
  // ... rest unchanged
};
```

- [ ] **Step 4: Add colors for new statuses**

In `packages/web/src/lib/phases.ts:77-106`, add cases to `getPhaseStatusColor()`:

```typescript
case "planning":
  return "var(--color-status-working)";
case "reviewing":
  return "var(--color-status-attention)";
```

Add these after the `"working"` case (line 80).

- [ ] **Step 5: Run web typecheck**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm --filter @aoagents/ao-web typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/lib/types.ts packages/web/src/lib/phases.ts
git commit -m "feat(web): add planning and reviewing statuses to phase lanes and labels"
```

---

### Task 7: Add adversarial round pill to SessionCard

**Files:**
- Modify: `packages/web/src/components/SessionCard.tsx`
- Test: `packages/web/src/components/__tests__/SessionCard.test.tsx` (if exists, else create)

- [ ] **Step 1: Add round pill rendering logic**

In `packages/web/src/components/SessionCard.tsx`, find where the status badge is rendered (around lines 174-177 based on the explored structure). Add a small pill after the status indicator when adversarial metadata is present:

```tsx
{session.metadata?.["adversarialRound"] && (
  <span
    className="inline-flex items-center rounded-full bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-xs font-medium text-[var(--color-text-secondary)]"
  >
    Round {parseInt(session.metadata["adversarialRound"], 10) + 1}
    /{session.metadata["adversarialPlanMaxRounds"] ?? "?"}
  </span>
)}
```

**Important:** No inline `style=` attributes — CLAUDE.md C-02 prohibits them. Use Tailwind arbitrary value syntax `bg-[var(--color-*)]` instead.

- [ ] **Step 2: Update `getFooterStatusLabel()` for new statuses**

In `packages/web/src/components/SessionCard.tsx`, find `getFooterStatusLabel()` (around line 782-793). Add:

```typescript
case "planning":
  return "planning";
case "reviewing":
  return session.metadata?.["adversarialPhase"] === "code_review" ? "code review" : "plan review";
```

- [ ] **Step 3: Run web typecheck**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm --filter @aoagents/ao-web typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/SessionCard.tsx
git commit -m "feat(web): render adversarial round pill in SessionCard"
```

---

## Chunk 6: Exhaustive Switch Fixes & Integration

### Task 8: Fix exhaustive switch/if-else chains for new statuses

**Files:**
- Various files that switch on `SessionStatus`

- [ ] **Step 1: Run full typecheck and collect errors**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm typecheck 2>&1`
Expected: List of files with exhaustive switch errors for `"planning"` and `"reviewing"`

- [ ] **Step 2: Fix each file**

For each error, add the new statuses to the appropriate branch:
- In `lifecycle-manager.ts` transition map: `"planning"` and `"reviewing"` should map to appropriate events (or be handled silently if no event is needed).
- In `getAttentionLevel()` in web types: map to `"working"` attention level.
- In any other exhaustive checks: follow the existing pattern for pre-PR statuses.

Generally:
- `"planning"` behaves like `"spawning"` → maps to `"working"` attention, `prePr` lane
- `"reviewing"` behaves like `"spawning"` → maps to `"working"` attention, `prePr` lane

- [ ] **Step 3: Run full typecheck again**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm typecheck`
Expected: PASS — zero errors

- [ ] **Step 4: Run full test suite**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm test`
Expected: PASS — no regressions

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(core,web): handle planning and reviewing in all exhaustive status checks"
```

---

### Task 9: Ensure `.ao/adversarial/` directory, `.gitignore`, and `round.json` consistency

**Files:**
- Modify: `packages/core/src/session-manager.ts` (in spawn and swapAgent)

- [ ] **Step 1: Add directory creation to spawn when adversarial is enabled**

In `spawn()`, after workspace creation and before prompt building, when `isAdversarial` is true:

```typescript
if (isAdversarial) {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const adversarialDir = join(workspacePath, ".ao", "adversarial");
  mkdirSync(adversarialDir, { recursive: true });

  // Write initial round.json — kept in sync with metadata on every phase transition
  writeFileSync(
    join(adversarialDir, "round.json"),
    JSON.stringify({ phase: "planning", round: 0, updatedAt: new Date().toISOString() }),
  );
}
```

- [ ] **Step 2: Update `round.json` in `swapAgent()` on every phase transition**

In `swapAgent()`, after the metadata update (step 8), add:

```typescript
// 9. Keep round.json in sync with metadata (machine-readable state for debugging)
try {
  const { writeFileSync } = await import("node:fs");
  const adversarialDir = join(workspacePath, ".ao", "adversarial");
  writeFileSync(
    join(adversarialDir, "round.json"),
    JSON.stringify({
      phase: opts.newStatus,
      adversarialPhase: opts.metadataUpdates.adversarialPhase ?? meta.adversarialPhase,
      round: parseInt(opts.metadataUpdates.adversarialRound ?? meta.adversarialRound ?? "0", 10),
      agent: selection.agentName,
      updatedAt: new Date().toISOString(),
    }),
  );
} catch {
  // Non-fatal — round.json is for debugging only
}
```

This ensures `round.json` stays in sync with metadata on every transition, not just at spawn. The file is orchestrator-managed JSON (harder for agents to tamper with than metadata files).

- [ ] **Step 3: Verify .gitignore convention**

The `.ao/` directory is already gitignored by convention (existing `.ao/activity.jsonl` pattern). Verify the workspace's `.gitignore` includes `.ao/`. The existing `setupPathWrapperWorkspace()` already creates `.ao/AGENTS.md`, so this should be handled.

- [ ] **Step 4: Run tests**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm --filter @aoagents/ao-core test -- --run adversarial-validation`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session-manager.ts
git commit -m "feat(core): create .ao/adversarial/ directory and keep round.json in sync"
```

---

### Task 10: Full verification

- [ ] **Step 1: Run full typecheck**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm typecheck`
Expected: PASS

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm test`
Expected: PASS

- [ ] **Step 3: Run web tests**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm --filter @aoagents/ao-web test`
Expected: PASS

- [ ] **Step 4: Run lint**

Run: `cd /Users/vitor/LocalProjects/agent-orchestrator && pnpm lint`
Expected: PASS (or only pre-existing warnings)

- [ ] **Step 5: Verify disable-path — config without adversarialReview**

Confirm that when `adversarialReview` is omitted from config, `spawn()` produces a session with status `"spawning"` (not `"planning"`) and no adversarial metadata fields are written. This is a manual code review check.

- [ ] **Step 6: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore: final adversarial validation cleanup and verification"
```

---

### Task 11: Document the `adversarialReview` YAML config

**Files:**
- Modify or Create: `docs/config.md` (or equivalent existing config docs)

The spec explicitly requires documenting the `adversarialReview` YAML block.

- [ ] **Step 1: Check if `docs/config.md` exists**

Run: `ls docs/config.md 2>/dev/null || echo "NOT FOUND"`

If not found, create `docs/config.md`. If another config doc exists (check `docs/` directory), add to it instead.

- [ ] **Step 2: Write the `adversarialReview` config documentation**

```markdown
## Adversarial Review (optional)

Enable multi-agent plan/code review within a single session. A primary agent drafts and implements; a critic agent reviews at checkpoints.

```yaml
projects:
  my-app:
    agent: claude-code
    adversarialReview:
      enabled: true
      critic:
        agent: codex
        agentConfig:           # optional overrides for critic
          model: "o3"
          permissions: "permissionless"
      plan:
        enabled: true          # run plan-review loop (default: true)
        maxRounds: 2           # plan↔critique cycles (default: 2)
      code:
        enabled: true          # run code-review before PR (default: true)
        maxRounds: 1           # code↔critique cycles (default: 1)
```

### How it works

1. **Planning:** Primary agent writes `.ao/adversarial/plan.md`
2. **Plan Review:** Critic agent writes `.ao/adversarial/plan.critique.md`
3. **Refine:** Primary revises plan (repeats for `plan.maxRounds`)
4. **Implementation:** Primary implements the plan
5. **Code Review:** Critic reviews the diff, writes `.ao/adversarial/code.critique.md`
6. **Fix:** Primary addresses critique (repeats for `code.maxRounds`)
7. Normal PR flow continues

### Constraints

- Primary must be `claude-code` in v1 (resume support required)
- Critic can be any agent (codex recommended — stateless, fast)
- Session ID, workspace, and branch are preserved across agent swaps
```

- [ ] **Step 3: Commit**

```bash
git add docs/config.md
git commit -m "docs: add adversarialReview YAML config documentation"
```
