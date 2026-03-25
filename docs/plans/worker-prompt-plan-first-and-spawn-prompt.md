# Plan: Worker default prompt (plan-first) + `ao spawn --prompt`

## Problem statement

1. **Default behavior** — Agents rush to implementation and PR creation, producing low-quality changes. The desired default is **planning mode**: analyze the problem, research the codebase, and produce a written plan. Implementation happens **only when the user explicitly requests it**.

2. **Per-spawn context** — Callers need a way to add session-specific instructions (e.g., constraints, scope, "investigate only"). Core already supports `SessionSpawnConfig.prompt` → `buildPrompt({ userPrompt })`, but the CLI doesn't expose it.

---

## Completed work ✅

### A. Plan-first default in `BASE_AGENT_PROMPT`

**File:** `packages/core/src/prompt-builder.ts`

**Changes made:**

1. Session Lifecycle states: "Your default mode is PLANNING, not coding" and "Only implement code when the user explicitly requests it"
2. Added: "If no task or issue is specified, wait for instructions. Do not proactively research..."
3. New `## Planning workflow` section with plan document structure
4. `.feature-plans/{pending,wip,done}/` directory convention
5. Explicit gate: "Do not start implementation until the user approves"

**Tests:** `packages/core/src/__tests__/prompt-builder.test.ts` updated with assertions.

---

## Remaining work (implemented)

The items below are done in the codebase; this section is kept as a record of what changed.

### B1. Add `--prompt` option to `ao spawn`

**File:** `packages/cli/src/commands/spawn.ts`

**Step 1:** Add option to command definition (around line 168):

```typescript
.option("--prompt <text>", "Session-specific instructions (appears early in agent prompt)")
```

**Step 2:** Add `prompt` to opts type (around line 174):

```typescript
opts: {
  open?: boolean;
  agent?: string;
  claimPr?: string;
  assignOnGithub?: boolean;
  decompose?: boolean;
  maxDepth?: string;
  prompt?: string;  // <-- ADD THIS
},
```

**Step 3:** Pass `prompt` to `spawnSession()` calls. Update `spawnSession` function signature (line 86) to accept `prompt`:

```typescript
async function spawnSession(
  config: OrchestratorConfig,
  projectId: string,
  issueId?: string,
  openTab?: boolean,
  agent?: string,
  claimOptions?: SpawnClaimOptions,
  prompt?: string,  // <-- ADD THIS
): Promise<string> {
```

**Step 4:** Inside `spawnSession`, pass `prompt` to `sm.spawn()` (around line 100):

```typescript
const session = await sm.spawn({
  projectId,
  issueId,
  agent,
  prompt,  // <-- ADD THIS
});
```

**Step 5:** Update all `spawnSession()` call sites to pass `opts.prompt`:

- Line 256: `await spawnSession(config, projectId, issueId, opts.open, opts.agent, claimOptions, opts.prompt);`
- Line 283: `await spawnSession(config, projectId, issueId, opts.open, opts.agent, claimOptions, opts.prompt);`

**Step 6:** For decomposer child spawns (line 266), pass `prompt` to `sm.spawn()`:

```typescript
const session = await sm.spawn({
  projectId,
  issueId,
  lineage: leaf.lineage,
  siblings,
  agent: opts.agent,
  prompt: opts.prompt,  // <-- ADD THIS
});
```

---

### B2. Add `--prompt` option to `ao batch-spawn`

**File:** `packages/cli/src/commands/spawn.ts`

**Step 1:** Add option to batch-spawn command (around line 298):

```typescript
.option("--prompt <text>", "Instructions applied to every spawned session")
```

**Step 2:** Update opts type in action handler (line 299):

```typescript
.action(async (issues: string[], opts: { open?: boolean; prompt?: string }) => {
```

**Step 3:** Pass `prompt` to `sm.spawn()` call (line 367):

```typescript
const session = await sm.spawn({ projectId, issueId: issue, prompt: opts.prompt });
```

---

### B3. Move `userPrompt` to early position as `## Session Focus`

**File:** `packages/core/src/prompt-builder.ts`

**Current code (lines 171-210):**

```typescript
export function buildPrompt(config: PromptBuildConfig): string {
  const userRules = readUserRules(config.project);
  const sections: string[] = [];

  // Layer 1: Base prompt
  sections.push(BASE_AGENT_PROMPT);

  // Layer 2: Config-derived context
  sections.push(buildConfigLayer(config));

  // Layer 3: User rules
  if (userRules) {
    sections.push(`## Project Rules\n${userRules}`);
  }

  // Layer 4: Decomposition context
  // ... lineage and siblings handling ...

  // Explicit user prompt (appended last)
  if (config.userPrompt) {
    sections.push(`## Additional Instructions\n${config.userPrompt}`);
  }

  return sections.join("\n\n");
}
```

**Change:** Move `userPrompt` handling to immediately after `BASE_AGENT_PROMPT`, rename section to `## Session Focus`:

```typescript
export function buildPrompt(config: PromptBuildConfig): string {
  const userRules = readUserRules(config.project);
  const sections: string[] = [];

  // Layer 1: Base prompt
  sections.push(BASE_AGENT_PROMPT);

  // Layer 2: Session focus (user prompt) — early so agent sees it immediately
  if (config.userPrompt) {
    sections.push(`## Session Focus\n${config.userPrompt}`);
  }

  // Layer 3: Config-derived context
  sections.push(buildConfigLayer(config));

  // Layer 4: User rules
  if (userRules) {
    sections.push(`## Project Rules\n${userRules}`);
  }

  // Layer 5: Decomposition context
  // ... lineage and siblings handling (unchanged) ...

  return sections.join("\n\n");
}
```

---

### B4. Tests

**File:** `packages/cli/__tests__/commands/spawn.test.ts`

Add test for `ao spawn --prompt`:

```typescript
it("passes --prompt to sessionManager.spawn()", async () => {
  const fakeSession = {
    id: "app-1",
    projectId: "my-app",
    status: "spawning",
    branch: "feat/test",
    workspacePath: "/tmp/ws",
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    agentInfo: null,
  };

  mockSessionManager.spawn.mockResolvedValue(fakeSession);

  await program.parseAsync(["node", "test", "spawn", "INT-42", "--prompt", "Focus on API only"]);

  expect(mockSessionManager.spawn).toHaveBeenCalledWith({
    projectId: "my-app",
    issueId: "INT-42",
    agent: undefined,
    prompt: "Focus on API only",
  });
});
```

Add test for `ao batch-spawn --prompt`:

```typescript
it("passes --prompt to all spawned sessions in batch-spawn", async () => {
  const fakeSession = { /* ... */ };
  mockSessionManager.spawn.mockResolvedValue(fakeSession);
  mockSessionManager.list.mockResolvedValue([]);

  await program.parseAsync(["node", "test", "batch-spawn", "INT-1", "INT-2", "--prompt", "Be concise"]);

  expect(mockSessionManager.spawn).toHaveBeenCalledTimes(2);
  expect(mockSessionManager.spawn).toHaveBeenCalledWith(
    expect.objectContaining({ issueId: "INT-1", prompt: "Be concise" })
  );
  expect(mockSessionManager.spawn).toHaveBeenCalledWith(
    expect.objectContaining({ issueId: "INT-2", prompt: "Be concise" })
  );
});
```

**File:** `packages/core/src/__tests__/prompt-builder.test.ts`

Add test for early `## Session Focus` position:

```typescript
it("renders userPrompt as Session Focus before Project Context", () => {
  const result = buildPrompt({
    project,
    projectId: "test-app",
    userPrompt: "Focus on the API layer only.",
  });

  const sessionFocusIdx = result.indexOf("## Session Focus");
  const projectContextIdx = result.indexOf("## Project Context");

  expect(sessionFocusIdx).toBeGreaterThan(-1);
  expect(projectContextIdx).toBeGreaterThan(-1);
  expect(sessionFocusIdx).toBeLessThan(projectContextIdx);
  expect(result).toContain("Focus on the API layer only.");
});
```

Update existing test that checks for `## Additional Instructions` (line 149) — it should now check for `## Session Focus` instead.

---

## Verification

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

Manual smoke test:

```bash
ao spawn INT-123 --prompt "Focus on API layer only, ignore frontend."
# Attach to tmux and verify prompt shows ## Session Focus early
```

---

## Implementation Checklist

### Completed ✅

- [x] Plan-first default behavior in `BASE_AGENT_PROMPT`
- [x] Planning workflow section with plan document structure
- [x] `.feature-plans/{pending,wip,done}/` convention
- [x] "Wait for instructions" when no task/issue specified
- [x] Tests for `BASE_AGENT_PROMPT` content

### B1. `ao spawn --prompt` (`packages/cli/src/commands/spawn.ts`)

- [x] Add `.option("--prompt <text>", ...)` to spawn command (around line 168)
- [x] Add `prompt?: string` to opts type (around line 174)
- [x] Add `prompt?: string` parameter to `spawnSession()` function signature (line 86)
- [x] Pass `prompt` to `sm.spawn()` inside `spawnSession()` (around line 100)
- [x] Update `spawnSession()` call at line 256 to pass `opts.prompt`
- [x] Update `spawnSession()` call at line 283 to pass `opts.prompt`
- [x] Add `prompt: opts.prompt` to decomposer `sm.spawn()` call (line 266)

### B2. `ao batch-spawn --prompt` (`packages/cli/src/commands/spawn.ts`)

- [x] Add `.option("--prompt <text>", ...)` to batch-spawn command (around line 298)
- [x] Update opts type in action handler to include `prompt?: string`
- [x] Pass `prompt: opts.prompt` to `sm.spawn()` call (line 367)

### B3. Move `userPrompt` to early position (`packages/core/src/prompt-builder.ts`)

- [x] Move `userPrompt` handling to immediately after `BASE_AGENT_PROMPT` (in `buildPrompt()`)
- [x] Rename section header from `## Additional Instructions` to `## Session Focus`

### B4. Tests

**CLI tests** (`packages/cli/__tests__/commands/spawn.test.ts`):

- [x] Add test: `ao spawn --prompt` passes prompt to `sessionManager.spawn()`
- [x] Add test: `ao spawn <issue> --prompt` passes both issueId and prompt
- [x] Add test: `ao batch-spawn --prompt` passes prompt to all spawned sessions

**Prompt builder tests** (`packages/core/src/__tests__/prompt-builder.test.ts`):

- [x] Add test: `## Session Focus` appears before `## Project Context` when `userPrompt` is set
- [x] Update existing test (line ~149) that checks for `## Additional Instructions` → should now check for `## Session Focus`

### Final verification

- [x] `pnpm --filter @composio/ao-core build` passes (required so CLI vitest can resolve `@composio/ao-core`)
- [x] `pnpm --filter @composio/ao-core typecheck` passes
- [x] Targeted tests: `prompt-builder.test.ts` + `spawn.test.ts` pass
- [ ] Full-repo `pnpm typecheck` / `pnpm test` / `pnpm lint` (may depend on workspace build state; run before merge)
- [ ] Manual smoke test: `ao spawn INT-123 --prompt "..."` shows `## Session Focus` early in prompt
