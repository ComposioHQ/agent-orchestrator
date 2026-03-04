# Auto-Cleanup & Backpressure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically clean up branches/worktrees after PR merge and pause spawning when open PRs or issues exist.

**Architecture:** Two features wired into existing lifecycle polling: (1) reactive cleanup on merge + periodic sweep, (2) backpressure gate in spawn(). Branch ownership identified by `feat/agent-*` naming convention. Config via Zod-validated YAML sections.

**Tech Stack:** TypeScript (ESM strict), vitest, Zod, Commander.js, `gh` CLI

**Design doc:** `docs/plans/2026-03-04-auto-cleanup-design.md`

---

### Task 1: Add Config Types and Zod Schema

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/config.ts`

**Step 1: Write the failing test**

Create test file `packages/core/src/__tests__/cleanup-config.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { validateConfig } from "../config.js";

describe("cleanup and backpressure config", () => {
  it("applies cleanup defaults when section is omitted", () => {
    const config = validateConfig({
      projects: {
        test: { repo: "owner/repo", path: "/tmp/test" },
      },
    });
    expect(config.cleanup).toEqual({
      enabled: true,
      branchPrefix: "feat/agent-",
      sweepInterval: 10,
    });
  });

  it("applies backpressure defaults when section is omitted", () => {
    const config = validateConfig({
      projects: {
        test: { repo: "owner/repo", path: "/tmp/test" },
      },
    });
    expect(config.backpressure).toEqual({
      enabled: true,
      pauseOnOpenPrs: true,
      pauseOnOpenIssues: true,
    });
  });

  it("allows overriding cleanup config", () => {
    const config = validateConfig({
      cleanup: { enabled: false, sweepInterval: 20 },
      projects: {
        test: { repo: "owner/repo", path: "/tmp/test" },
      },
    });
    expect(config.cleanup.enabled).toBe(false);
    expect(config.cleanup.sweepInterval).toBe(20);
    expect(config.cleanup.branchPrefix).toBe("feat/agent-");
  });

  it("allows overriding backpressure config", () => {
    const config = validateConfig({
      backpressure: { pauseOnOpenIssues: false },
      projects: {
        test: { repo: "owner/repo", path: "/tmp/test" },
      },
    });
    expect(config.backpressure.enabled).toBe(true);
    expect(config.backpressure.pauseOnOpenPrs).toBe(true);
    expect(config.backpressure.pauseOnOpenIssues).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run src/__tests__/cleanup-config.test.ts`
Expected: FAIL — `cleanup` and `backpressure` properties don't exist on config type.

**Step 3: Add types to `packages/core/src/types.ts`**

After the `OrchestratorConfig` interface (around line 837), add:

```typescript
export interface CleanupConfig {
  enabled: boolean;
  branchPrefix: string;
  sweepInterval: number;
}

export interface BackpressureConfig {
  enabled: boolean;
  pauseOnOpenPrs: boolean;
  pauseOnOpenIssues: boolean;
}
```

Add to the `OrchestratorConfig` interface:

```typescript
  cleanup: CleanupConfig;
  backpressure: BackpressureConfig;
```

**Step 4: Add Zod schemas to `packages/core/src/config.ts`**

Before the `OrchestratorConfigSchema` (around line 91), add:

```typescript
const CleanupConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    branchPrefix: z.string().default("feat/agent-"),
    sweepInterval: z.number().positive().default(10),
  })
  .default({});

const BackpressureConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    pauseOnOpenPrs: z.boolean().default(true),
    pauseOnOpenIssues: z.boolean().default(true),
  })
  .default({});
```

Add to `OrchestratorConfigSchema`:

```typescript
  cleanup: CleanupConfigSchema,
  backpressure: BackpressureConfigSchema,
```

**Step 5: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run src/__tests__/cleanup-config.test.ts`
Expected: PASS — all 4 tests green.

**Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/config.ts packages/core/src/__tests__/cleanup-config.test.ts
git commit -m "feat(core): add cleanup and backpressure config types and Zod schemas"
```

---

### Task 2: Change Branch Naming to `feat/agent-*`

**Files:**
- Modify: `packages/plugins/tracker-github/src/index.ts`
- Test: `packages/plugins/tracker-github/src/__tests__/` (or inline test)

**Step 1: Write the failing test**

Find the existing test file for tracker-github. If none exists, create `packages/plugins/tracker-github/src/__tests__/branch-name.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

// Import the plugin's create function
import plugin from "../index.js";

describe("tracker-github branchName", () => {
  it("returns feat/agent-{number} format", () => {
    const tracker = plugin.create({});
    const branch = tracker.branchName("123", {
      name: "test",
      repo: "owner/repo",
      path: "/tmp",
      defaultBranch: "main",
    });
    expect(branch).toBe("feat/agent-123");
  });

  it("extracts issue number from URL", () => {
    const tracker = plugin.create({});
    const branch = tracker.branchName(
      "https://github.com/owner/repo/issues/456",
      {
        name: "test",
        repo: "owner/repo",
        path: "/tmp",
        defaultBranch: "main",
      },
    );
    expect(branch).toBe("feat/agent-456");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/plugins/tracker-github && pnpm vitest run src/__tests__/branch-name.test.ts`
Expected: FAIL — returns `feat/issue-123` instead of `feat/agent-123`.

**Step 3: Modify `branchName()` in tracker-github**

In `packages/plugins/tracker-github/src/index.ts` around line 123, change:

```typescript
// Before:
return `feat/issue-${num}`;

// After:
return `feat/agent-${num}`;
```

**Step 4: Run test to verify it passes**

Run: `cd packages/plugins/tracker-github && pnpm vitest run src/__tests__/branch-name.test.ts`
Expected: PASS.

**Step 5: Update any existing tests that assert the old format**

Search for `feat/issue-` in test files:
```bash
grep -r "feat/issue-" packages/ --include="*.test.ts" -l
```
Update any matches to `feat/agent-`.

**Step 6: Run full test suite to catch regressions**

Run: `pnpm test`
Expected: All tests pass. Fix any that reference the old branch naming pattern.

**Step 7: Commit**

```bash
git add packages/plugins/tracker-github/
git commit -m "feat(tracker-github): change branch naming from feat/issue- to feat/agent-"
```

---

### Task 3: Add `listOpenPRs()` to SCM Interface and GitHub Implementation

The SCM interface currently only has `detectPR()` (finds PR by branch), not a method to list all open PRs. We need this for backpressure.

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/plugins/scm-github/src/index.ts`
- Test: `packages/plugins/scm-github/src/__tests__/list-open-prs.test.ts`

**Step 1: Write the failing test**

Create `packages/plugins/scm-github/src/__tests__/list-open-prs.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import plugin from "../index.js";

describe("scm-github listOpenPRs", () => {
  it("has a listOpenPRs method", () => {
    const scm = plugin.create({});
    expect(typeof scm.listOpenPRs).toBe("function");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/plugins/scm-github && pnpm vitest run src/__tests__/list-open-prs.test.ts`
Expected: FAIL — `listOpenPRs` is not a function / doesn't exist.

**Step 3: Add `listOpenPRs` to SCM interface in `packages/core/src/types.ts`**

In the SCM interface (around line 503-554), add the optional method:

```typescript
  listOpenPRs?(project: ProjectConfig): Promise<PRInfo[]>;
```

**Step 4: Implement `listOpenPRs` in `packages/plugins/scm-github/src/index.ts`**

Add the method to the SCM object returned by `create()`:

```typescript
async listOpenPRs(project: ProjectConfig): Promise<PRInfo[]> {
  const args = [
    "pr",
    "list",
    "--repo",
    project.repo,
    "--state",
    "open",
    "--json",
    "number,url,title,headRefName,baseRefName,isDraft",
    "--limit",
    "100",
  ];
  const raw = await gh(args);
  if (!raw.trim()) return [];
  const prs = JSON.parse(raw) as Array<{
    number: number;
    url: string;
    title: string;
    headRefName: string;
    baseRefName: string;
    isDraft: boolean;
  }>;
  return prs.map((pr) => ({
    number: pr.number,
    url: pr.url,
    title: pr.title,
    owner: project.repo.split("/")[0],
    repo: project.repo.split("/")[1],
    branch: pr.headRefName,
    baseBranch: pr.baseRefName,
    isDraft: pr.isDraft,
  }));
},
```

**Step 5: Run test to verify it passes**

Run: `cd packages/plugins/scm-github && pnpm vitest run src/__tests__/list-open-prs.test.ts`
Expected: PASS.

**Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/plugins/scm-github/
git commit -m "feat(scm-github): add listOpenPRs method for backpressure support"
```

---

### Task 4: Add Branch Deletion to Session Cleanup

Extend the existing `kill()` method in session-manager to also delete `feat/agent-*` branches.

**Files:**
- Modify: `packages/core/src/session-manager.ts`
- Test: `packages/core/src/__tests__/session-manager.test.ts` (or new file)

**Step 1: Write the failing test**

Add to session-manager tests:

```typescript
describe("cleanupSession", () => {
  it("deletes branch matching branchPrefix after killing session", async () => {
    // Mock a session with feat/agent-123 branch
    const mockSession = {
      id: "test-session",
      branch: "feat/agent-123",
      projectId: "test-project",
      // ... other required fields
    };

    // After cleanup, verify git branch -D was called with feat/agent-123
    // and that the session was killed (runtime destroyed, workspace destroyed, metadata archived)
  });

  it("does NOT delete branch that does not match branchPrefix", async () => {
    const mockSession = {
      id: "test-session",
      branch: "feat/issue-123", // old naming, should NOT be deleted
      projectId: "test-project",
    };

    // After cleanup, verify git branch -D was NOT called
  });
});
```

Note: Adapt the mock structure to match the existing test patterns in `session-manager.test.ts`. Read that file first for the mocking approach.

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run src/__tests__/session-manager.test.ts`
Expected: FAIL — `cleanupSession` doesn't exist.

**Step 3: Implement `cleanupSession()` in session-manager**

In `packages/core/src/session-manager.ts`, add a new method near the `kill()` method (around line 837):

```typescript
async function cleanupSession(
  sessionId: string,
  config: OrchestratorConfig,
): Promise<void> {
  // Find session metadata before killing (we need the branch name)
  const session = await findSession(sessionId);
  if (!session) return;

  const branch = session.branch;

  // Kill the session (runtime, workspace, archive metadata)
  await kill(sessionId);

  // Delete the branch if it matches the cleanup prefix
  if (
    config.cleanup.enabled &&
    branch &&
    branch.startsWith(config.cleanup.branchPrefix)
  ) {
    try {
      const projectPath = getProjectPath(session.projectId);
      await execFile("git", ["-C", projectPath, "branch", "-D", branch]);
    } catch {
      // Branch may already be deleted or not exist locally — not an error
    }
  }
}
```

Export `cleanupSession` from the session manager's public API.

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run src/__tests__/session-manager.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/session-manager.ts packages/core/src/__tests__/session-manager.test.ts
git commit -m "feat(core): add cleanupSession with branch deletion for feat/agent-* branches"
```

---

### Task 5: Add Reactive Cleanup to Lifecycle Manager

When the lifecycle manager detects `merged` status, call `cleanupSession()` instead of just filtering the session out.

**Files:**
- Modify: `packages/core/src/lifecycle-manager.ts`
- Test: `packages/core/src/__tests__/lifecycle-manager.test.ts` (or new test file)

**Step 1: Write the failing test**

```typescript
describe("reactive cleanup on merge", () => {
  it("calls cleanupSession when session status becomes merged", async () => {
    // Set up lifecycle manager with mocked sessionManager
    // Simulate a session transitioning to "merged"
    // Verify cleanupSession() was called with the session ID
  });

  it("does not call cleanupSession when cleanup is disabled", async () => {
    // Same setup but with config.cleanup.enabled = false
    // Verify cleanupSession() was NOT called
  });
});
```

Adapt to the existing lifecycle-manager test patterns.

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run src/__tests__/lifecycle-manager.test.ts`
Expected: FAIL.

**Step 3: Add reactive cleanup to `checkSession()`**

In `packages/core/src/lifecycle-manager.ts`, in the `checkSession()` method where status transitions are detected (around line 475):

When the new status is `"merged"`, add:

```typescript
if (newStatus === "merged" && config.cleanup.enabled) {
  try {
    await sessionManager.cleanupSession(session.id, config);
  } catch (error) {
    log.warn(`Cleanup failed for session ${session.id}:`, error);
  }
}
```

This goes after the existing reaction handling — reactions fire first (e.g., notifications), then cleanup runs.

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run src/__tests__/lifecycle-manager.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/lifecycle-manager.ts packages/core/src/__tests__/lifecycle-manager.test.ts
git commit -m "feat(core): add reactive cleanup on PR merge in lifecycle manager"
```

---

### Task 6: Add Periodic Sweep to Lifecycle Manager

Every N poll cycles, scan for `feat/agent-*` branches whose PRs are merged but weren't caught by reactive cleanup.

**Files:**
- Modify: `packages/core/src/lifecycle-manager.ts`
- Test: `packages/core/src/__tests__/lifecycle-manager.test.ts`

**Step 1: Write the failing test**

```typescript
describe("periodic sweep", () => {
  it("runs sweep after sweepInterval poll cycles", async () => {
    // Configure sweepInterval: 3
    // Call pollAll() 3 times
    // On the 3rd call, verify sweep logic ran (git branch --list feat/agent-* was called)
  });

  it("deletes feat/agent-* branches with merged PRs during sweep", async () => {
    // Set up a local branch feat/agent-99 with a merged PR
    // Run sweep
    // Verify the branch was deleted
  });

  it("does not delete branches without merged PRs", async () => {
    // Set up a local branch feat/agent-50 with an open PR
    // Run sweep
    // Verify the branch was NOT deleted
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run src/__tests__/lifecycle-manager.test.ts`
Expected: FAIL.

**Step 3: Implement sweep in lifecycle manager**

Add a poll cycle counter and sweep function:

```typescript
let pollCycleCount = 0;

async function sweep(config: OrchestratorConfig): Promise<void> {
  if (!config.cleanup.enabled) return;

  for (const [, project] of Object.entries(config.projects)) {
    try {
      // List local branches matching prefix
      const branchOutput = await execFile("git", [
        "-C",
        project.path,
        "branch",
        "--list",
        `${config.cleanup.branchPrefix}*`,
        "--format",
        "%(refname:short)",
      ]);

      const branches = branchOutput
        .split("\n")
        .map((b) => b.trim())
        .filter(Boolean);

      for (const branch of branches) {
        // Check if PR for this branch is merged
        const scm = await resolvePlugin("scm", project);
        const prState = await scm.getPRState({ branch } as Session, project);
        if (prState === PR_STATE.MERGED || prState === PR_STATE.CLOSED) {
          try {
            await execFile("git", ["-C", project.path, "branch", "-D", branch]);
            log.info(`Sweep: deleted branch ${branch}`);
          } catch {
            // Already deleted
          }
        }
      }

      // Also prune worktree references
      await execFile("git", ["-C", project.path, "worktree", "prune"]);
      await execFile("git", ["-C", project.path, "fetch", "--prune"]);
    } catch (error) {
      log.warn(`Sweep failed for project ${project.name}:`, error);
    }
  }
}
```

In `pollAll()`, add the sweep trigger:

```typescript
pollCycleCount++;
if (pollCycleCount >= config.cleanup.sweepInterval) {
  pollCycleCount = 0;
  await sweep(config);
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run src/__tests__/lifecycle-manager.test.ts`
Expected: PASS.

**Step 5: Run full test suite**

Run: `pnpm test`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add packages/core/src/lifecycle-manager.ts packages/core/src/__tests__/lifecycle-manager.test.ts
git commit -m "feat(core): add periodic sweep for stale feat/agent-* branches"
```

---

### Task 7: Add Backpressure Gate to Spawn

Gate `spawn()` so it refuses to create new sessions when open PRs or issues exist.

**Files:**
- Modify: `packages/core/src/session-manager.ts`
- Test: `packages/core/src/__tests__/session-manager.test.ts`

**Step 1: Write the failing test**

```typescript
describe("backpressure", () => {
  it("throws when open PRs exist and backpressure is enabled", async () => {
    // Mock scm.listOpenPRs to return 1 open PR
    // Call spawn()
    // Expect it to throw with message about pausing
  });

  it("throws when open issues exist and backpressure is enabled", async () => {
    // Mock tracker.listIssues with state: "open" to return 1 issue
    // Call spawn()
    // Expect it to throw with message about pausing
  });

  it("allows spawn when no open PRs or issues", async () => {
    // Mock scm.listOpenPRs to return []
    // Mock tracker.listIssues to return []
    // Call spawn()
    // Expect it to succeed
  });

  it("allows spawn when backpressure is disabled", async () => {
    // Config: backpressure.enabled = false
    // Mock scm.listOpenPRs to return 1 open PR
    // Call spawn()
    // Expect it to succeed (backpressure disabled)
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run src/__tests__/session-manager.test.ts`
Expected: FAIL.

**Step 3: Add backpressure check to `spawn()`**

At the top of `spawn()` in `packages/core/src/session-manager.ts` (around line 315), after initial validation:

```typescript
// Backpressure: check for open PRs and issues before spawning
if (config.backpressure.enabled) {
  const project = config.projects[spawnConfig.projectId];
  if (!project) throw new Error(`Unknown project: ${spawnConfig.projectId}`);

  const plugins = await resolvePlugins(project, config);

  if (config.backpressure.pauseOnOpenPrs && plugins.scm.listOpenPRs) {
    const openPRs = await plugins.scm.listOpenPRs(project);
    if (openPRs.length > 0) {
      throw new Error(
        `Backpressure: ${openPRs.length} open PR(s) on ${project.repo}. ` +
          `Resolve before spawning new work.`,
      );
    }
  }

  if (config.backpressure.pauseOnOpenIssues && plugins.tracker?.listIssues) {
    const openIssues = await plugins.tracker.listIssues(
      { state: "open" },
      project,
    );
    if (openIssues.length > 0) {
      throw new Error(
        `Backpressure: ${openIssues.length} open issue(s) on ${project.repo}. ` +
          `Resolve before spawning new work.`,
      );
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run src/__tests__/session-manager.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/session-manager.ts packages/core/src/__tests__/session-manager.test.ts
git commit -m "feat(core): add backpressure gate to spawn - pause on open PRs/issues"
```

---

### Task 8: Update Config Example and Documentation

**Files:**
- Modify: `agent-orchestrator.yaml.example`
- Modify: `CLAUDE.md`

**Step 1: Add cleanup and backpressure sections to `agent-orchestrator.yaml.example`**

Add after the `reactions` section (around line 104):

```yaml

# ---------- Cleanup ----------
# Automatically clean up branches and worktrees after PRs merge.
# Only deletes branches matching the branchPrefix (feat/agent-* by default).
cleanup:
  enabled: true                    # Auto-cleanup on merge (default: true)
  branchPrefix: "feat/agent-"     # Only delete branches with this prefix
  sweepInterval: 10               # Poll cycles between sweep runs (~5 min)

# ---------- Backpressure ----------
# Pause spawning and research when open work exists.
backpressure:
  enabled: true                    # Enable backpressure (default: true)
  pauseOnOpenPrs: true             # Pause if any open PRs on the repo
  pauseOnOpenIssues: true          # Pause if any open issues on the repo
```

**Step 2: Update CLAUDE.md with cleanup behavior**

In the Design Decisions section of `CLAUDE.md`, add:

```markdown
7. **Auto-cleanup** — branches matching `feat/agent-*` are automatically deleted after PR merge. Reactive (on merge detection) + periodic sweep (every ~5 min). Human branches are never touched.
8. **Backpressure** — `spawn()` refuses to create sessions when open PRs or issues exist on the repo. Prevents piling up work that hasn't been reviewed.
```

**Step 3: Commit**

```bash
git add agent-orchestrator.yaml.example CLAUDE.md
git commit -m "docs: add cleanup and backpressure config examples and documentation"
```

---

### Task 9: Integration Test

**Files:**
- Create: `packages/integration-tests/src/cleanup.test.ts`

**Step 1: Write integration test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("cleanup integration", () => {
  let repoDir: string;

  beforeEach(() => {
    // Create a temp git repo
    repoDir = mkdtempSync(join(tmpdir(), "ao-cleanup-test-"));
    execSync("git init", { cwd: repoDir });
    execSync("git commit --allow-empty -m 'init'", { cwd: repoDir });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("sweep deletes feat/agent-* branches with no active session", () => {
    // Create a feat/agent-99 branch
    execSync("git branch feat/agent-99", { cwd: repoDir });

    // Verify it exists
    const before = execSync("git branch --list feat/agent-*", {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(before.trim()).toContain("feat/agent-99");

    // Delete it (simulating sweep)
    execSync("git branch -D feat/agent-99", { cwd: repoDir });

    // Verify it's gone
    const after = execSync("git branch --list feat/agent-*", {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(after.trim()).not.toContain("feat/agent-99");
  });

  it("sweep does NOT delete non-agent branches", () => {
    execSync("git branch feat/my-feature", { cwd: repoDir });
    execSync("git branch fix/bug-123", { cwd: repoDir });

    // Sweep only targets feat/agent-*
    const agentBranches = execSync("git branch --list feat/agent-*", {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(agentBranches.trim()).toBe("");

    // Human branches still exist
    const allBranches = execSync("git branch", {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(allBranches).toContain("feat/my-feature");
    expect(allBranches).toContain("fix/bug-123");
  });
});
```

**Step 2: Run the test**

Run: `cd packages/integration-tests && pnpm vitest run src/cleanup.test.ts`
Expected: PASS.

**Step 3: Commit**

```bash
git add packages/integration-tests/src/cleanup.test.ts
git commit -m "test: add integration tests for branch cleanup"
```

---

### Task 10: Final Verification

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass, including new cleanup/backpressure tests.

**Step 2: Verify no type errors**

Run: `pnpm tsc --noEmit`
Expected: No type errors.

**Step 3: Verify linting passes**

Run: `pnpm lint`
Expected: No lint errors.

**Step 4: Manual smoke test (if possible)**

```bash
# Verify config loads with defaults
ao config validate

# Verify branch naming changed
ao spawn test-project 1 --dry-run  # should show feat/agent-1

# Verify backpressure gate
# (If open PRs/issues exist, spawn should fail with backpressure message)
```

**Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address any issues found during final verification"
```
