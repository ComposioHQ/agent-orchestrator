# Root Cause Analysis: CLAUDECODE Environment Variable Bug

**Date:** 2026-02-16
**Severity:** Critical (Silent failure - agents never started)
**Impact:** Sessions ao-22 through ao-25 spawned but failed silently
**Status:** Fixed in commit a686645

---

## Executive Summary

The `ao spawn` command failed to call `agent.getEnvironment()` when creating tmux sessions, causing spawned Claude Code agents to inherit the `CLAUDECODE` environment variable from the parent orchestrator session. This triggered Claude Code's nested session prevention, causing the agent to refuse to start with "cannot launch inside another Claude Code session" error. The bug affected all sessions spawned between Feb 14-16, 2026, resulting in silent failures where tmux sessions existed but no agent was running.

---

## Timeline of Events

### Feb 13, 2026 (Commit 29e1175)
**Event:** Agent plugin interface implemented
**Details:**
- Agent interface defined with `getEnvironment()` method
- Claude Code plugin implemented `getEnvironment()` to return `CLAUDECODE: ""`
- Method purpose: Provide agent-specific environment variables for session isolation
- Files: `packages/core/src/types.ts`, `packages/plugins/agent-claude-code/src/index.ts`

```typescript
// From agent-claude-code plugin
getEnvironment(config: AgentLaunchConfig): Record<string, string> {
  const env: Record<string, string> = {};

  // Unset CLAUDECODE to avoid nested agent conflicts
  env["CLAUDECODE"] = "";

  // Set session info for introspection
  env["AO_SESSION_ID"] = config.sessionId;
  env["AO_PROJECT_ID"] = config.projectConfig.name;
  // ...
}
```

### Feb 14, 2026 (Commit 2886ab2)
**Event:** CLI spawn command initial implementation
**Details:**
- Spawn command created with **hardcoded** agent launch logic
- Claude Code specifically handled: `unset CLAUDECODE && claude${perms}`
- **This was the correct approach** - CLAUDECODE was being unset in the shell command
- Files: `packages/cli/src/commands/spawn.ts`

```typescript
// Original implementation (CORRECT)
let launchCmd: string;
if (agentName === "claude-code") {
  const perms = project.agentConfig?.permissions === "skip"
    ? " --dangerously-skip-permissions"
    : "";
  launchCmd = `unset CLAUDECODE && claude${perms}`;  // ✓ Unsets CLAUDECODE
}
```

### Feb 14, 2026 (Commit ac424c1)
**Event:** Refactor to use agent plugins
**Details:**
- Moved agent-specific logic from CLI into agent plugins
- Replaced hardcoded agent launch commands with `agent.getLaunchCommand()`
- **BUG INTRODUCED:** Removed `unset CLAUDECODE &&` from spawn, but never called `agent.getEnvironment()`
- The refactor correctly used `getLaunchCommand()` but **forgot** the environment setup
- Files: `packages/cli/src/commands/spawn.ts`

```typescript
// After refactor (INCORRECT - missing getEnvironment call)
const agent = getAgent(config, projectId);
const launchCmd = agent.getLaunchCommand({
  sessionId: sessionName,
  projectConfig: project,
  issueId,
  permissions: project.agentConfig?.permissions,
});

// Creates tmux session with env vars, but NEVER calls getEnvironment()
await exec("tmux", [
  "new-session",
  "-d",
  "-s", sessionName,
  "-c", worktreePath,
  "-e", `${envVar}=${sessionName}`,
  "-e", "AO_DATA_DIR=...",
  "-e", "DIRENV_LOG_FORMAT=",
  // ❌ Missing: agent.getEnvironment() env vars
]);
```

### Feb 15, 2026 (Commit 77323cb, PR #42)
**Event:** Start command implemented **correctly**
**Details:**
- New `ao start` command for orchestrator agent
- **CORRECTLY called `agent.getEnvironment()`** and merged env vars
- This proves the pattern was known and documented
- Files: `packages/cli/src/commands/start.ts`

```typescript
// Start command (CORRECT implementation)
const agentEnv = agent.getEnvironment({
  sessionId,
  projectConfig: project,
  permissions: project.agentConfig?.permissions ?? "default",
  model: project.agentConfig?.model,
});
Object.assign(environment, agentEnv);  // ✓ Merges agent env vars

await newTmuxSession({
  name: sessionId,
  cwd: project.path,
  environment,  // ✓ Includes CLAUDECODE=""
});
```

### Feb 16, 2026 (Commit a686645)
**Event:** Bug discovered and fixed
**Details:**
- Sessions ao-22 through ao-25 failed silently
- Investigation revealed Claude never started in spawned sessions
- Root cause: CLAUDECODE inherited from parent orchestrator
- Fix: Added `agent.getEnvironment()` call to spawn command
- Files: `packages/cli/src/commands/spawn.ts`

---

## Root Cause Analysis

### What Went Wrong

1. **Interface-Implementation Gap**
   - Agent interface defined `getEnvironment()` method
   - Spawn command never called it
   - No compile-time enforcement that spawn must use this method

2. **Refactoring Oversight**
   - Original implementation had `unset CLAUDECODE &&` in shell command (worked correctly)
   - Refactor moved logic to plugins but only migrated `getLaunchCommand()`
   - Forgot to migrate the environment setup to `getEnvironment()` call
   - The two-step process (getLaunchCommand + getEnvironment) was not documented

3. **Inconsistent Implementation**
   - Start command (Feb 15) implemented it correctly
   - Spawn command (Feb 14) never implemented it
   - Same developers worked on both, but pattern wasn't consistently applied

4. **Silent Failure Mode**
   - Tmux sessions created successfully
   - Metadata files written
   - Claude Code failed with error message in terminal, but orchestrator continued
   - No health check to verify agent actually started
   - Dashboard showed sessions as "spawning" but they were stuck

### Why It Wasn't Caught

1. **Insufficient Test Coverage**
   - Tests mocked `getAgent()` with a stub that returned `getEnvironment: () => ({})`
   - Tests never verified that `getEnvironment()` was **actually called**
   - Tests only checked that launch command was sent via tmux send-keys
   - No integration tests that spawned real Claude sessions

```typescript
// From packages/cli/__tests__/commands/spawn.test.ts
mockGetAgent.mockReturnValue({
  name: "claude-code",
  processName: "claude",
  getLaunchCommand: () => "unset CLAUDECODE && claude",
  getEnvironment: () => ({}),  // ❌ Mock returns empty object, never verified it was called
  detectActivity: () => "idle",
});
```

2. **No Interface Contract Validation**
   - No runtime assertion that spawn called `getEnvironment()`
   - No linter/type rule enforcing the call
   - No documentation stating spawn MUST call both methods

3. **Manual Testing Gap**
   - Manual testing likely done from tmux sessions without CLAUDECODE set
   - Bug only manifests when spawning from inside an active Claude Code session
   - Orchestrator-spawning-workers scenario not tested

4. **Review Process**
   - PR review didn't catch that `getEnvironment()` was never called
   - Start command PR (#42) showed the correct pattern, but was merged after spawn
   - No cross-reference between the two implementations

---

## Prevention Measures

### 1. Integration Tests (High Priority)

Add integration tests that verify spawned agents actually start:

```typescript
// packages/cli/__tests__/commands/spawn.integration.test.ts
describe("spawn integration", () => {
  it("should spawn Claude Code agent that can process commands", async () => {
    // Spawn session
    const sessionId = await spawnSession(config, projectId);

    // Wait for agent to start
    await waitForAgentReady(sessionId, { timeout: 30_000 });

    // Verify agent is actually running
    const agentRunning = await isAgentProcessRunning(sessionId);
    expect(agentRunning).toBe(true);

    // Send a simple command and verify response
    await sendMessage(sessionId, "echo 'test'");
    const response = await waitForAgentResponse(sessionId);
    expect(response).toContain("test");
  });

  it("should unset CLAUDECODE when spawning from orchestrator session", async () => {
    // Set CLAUDECODE to simulate orchestrator session
    process.env.CLAUDECODE = "1";

    try {
      const sessionId = await spawnSession(config, projectId);

      // Verify CLAUDECODE is unset in spawned session
      const sessionEnv = await getSessionEnvironment(sessionId);
      expect(sessionEnv.CLAUDECODE).toBe("");
    } finally {
      delete process.env.CLAUDECODE;
    }
  });
});
```

### 2. Agent Plugin Contract Enforcement (Medium Priority)

Add runtime validation that spawn properly uses agent plugins:

```typescript
// packages/core/src/agent-contract.ts
export function validateAgentUsage(calls: {
  getLaunchCommand: boolean;
  getEnvironment: boolean;
}) {
  if (calls.getLaunchCommand && !calls.getEnvironment) {
    throw new Error(
      "Agent contract violation: getLaunchCommand() called without getEnvironment(). " +
      "When spawning an agent, you MUST call both methods to ensure proper isolation."
    );
  }
}

// In spawn.ts
const launchCmd = agent.getLaunchCommand(config);
const agentEnv = agent.getEnvironment(config);  // ✓ Both called
validateAgentUsage({ getLaunchCommand: true, getEnvironment: true });
```

### 3. Improved Test Assertions (High Priority)

Update spawn tests to verify `getEnvironment()` is actually called:

```typescript
it("should call agent.getEnvironment() and merge env vars", async () => {
  const mockGetEnvironment = vi.fn().mockReturnValue({
    CLAUDECODE: "",
    AO_SESSION_ID: "app-1"
  });

  mockGetAgent.mockReturnValue({
    name: "claude-code",
    getLaunchCommand: vi.fn().mockReturnValue("claude"),
    getEnvironment: mockGetEnvironment,
    // ...
  });

  await program.parseAsync(["node", "test", "spawn", "my-app"]);

  // ✓ Verify getEnvironment was called
  expect(mockGetEnvironment).toHaveBeenCalledWith({
    sessionId: "app-1",
    projectConfig: expect.any(Object),
    permissions: expect.any(String),
  });

  // ✓ Verify env vars passed to tmux
  expect(mockExec).toHaveBeenCalledWith(
    "tmux",
    expect.arrayContaining([
      "-e", "CLAUDECODE=",
      "-e", "AO_SESSION_ID=app-1"
    ])
  );
});
```

### 4. Documentation (Medium Priority)

Document the agent plugin contract in `CLAUDE.md`:

```markdown
## Agent Plugin Contract

When spawning an agent session, you MUST call two methods:

1. **`agent.getLaunchCommand(config)`** - Get the shell command to launch the agent
2. **`agent.getEnvironment(config)`** - Get environment variables for isolation

**Example (spawn.ts):**

```typescript
// Step 1: Get launch command
const launchCmd = agent.getLaunchCommand({
  sessionId,
  projectConfig: project,
  issueId,
  permissions: project.agentConfig?.permissions,
});

// Step 2: Get environment variables
const agentEnv = agent.getEnvironment({
  sessionId,
  projectConfig: project,
  issueId,
  permissions: project.agentConfig?.permissions,
});

// Step 3: Create tmux session with BOTH
await exec("tmux", [
  "new-session", "-d", "-s", sessionId,
  // ... other flags ...
]);

// Step 4: Add agent env vars
for (const [key, value] of Object.entries(agentEnv)) {
  tmuxArgs.push("-e", `${key}=${value}`);
}
```

**Why both are required:**
- `getLaunchCommand()` returns the command to execute
- `getEnvironment()` returns environment variables for isolation (e.g., unsetting CLAUDECODE)
- Forgetting `getEnvironment()` causes nested session errors
```

### 5. Health Check for Spawned Sessions (High Priority)

Add post-spawn verification that agent actually started:

```typescript
// After spawning
spinner.text = "Verifying agent startup";

// Wait up to 10s for agent to initialize
const startupTimeout = 10_000;
const startTime = Date.now();

while (Date.now() - startTime < startupTimeout) {
  const agentRunning = await agent.isProcessRunning(runtimeHandle);

  if (agentRunning) {
    spinner.succeed(`Session ${sessionName} created successfully`);
    return sessionName;
  }

  await new Promise(resolve => setTimeout(resolve, 500));
}

// If agent didn't start, clean up and fail
spinner.fail(`Session ${sessionName} created but agent failed to start`);
await runtime.destroy(runtimeHandle);
throw new Error("Agent failed to start - check terminal output for errors");
```

### 6. ESLint Rule (Low Priority, Future)

Create custom ESLint rule to detect agent method usage patterns:

```typescript
// .eslint/rules/agent-contract.js
module.exports = {
  rules: {
    "require-agent-environment": {
      create(context) {
        return {
          CallExpression(node) {
            if (node.callee.property?.name === "getLaunchCommand") {
              // Check if getEnvironment is called in the same scope
              // Warn if missing
            }
          }
        };
      }
    }
  }
};
```

### 7. Checklist for Agent Plugin Changes (High Priority)

Add to PR template when modifying agent plugins:

```markdown
## Agent Plugin Changes Checklist

When modifying agent plugins or spawn logic:

- [ ] Both `getLaunchCommand()` AND `getEnvironment()` are called
- [ ] Environment variables from `getEnvironment()` are passed to runtime
- [ ] Tests verify both methods are called
- [ ] Integration test verifies agent actually starts
- [ ] Tested spawning from inside another Claude Code session
- [ ] Documentation updated if contract changes
```

---

## Lessons Learned

1. **Refactoring Risk:** When moving hardcoded logic to plugins, ensure all aspects are migrated, not just the obvious ones (command generation)

2. **Two-Step Patterns Need Documentation:** When an interface requires calling multiple methods in sequence, document it clearly in code comments and CLAUDE.md

3. **Mock Verification:** Tests should verify that mocked methods are actually called, not just that they exist

4. **Silent Failures Are Dangerous:** Health checks should verify that critical operations (like agent startup) actually succeeded

5. **Inconsistent Implementation Patterns:** When the same pattern exists in multiple commands (spawn, start), they should use shared helpers to ensure consistency

6. **Manual Testing Scenarios:** Test the actual usage pattern (orchestrator spawning workers) not just the isolated command

---

## Related Issues

- **Affected Sessions:** ao-22, ao-23, ao-24, ao-25 (Feb 14-16, 2026)
- **Fix Commit:** a686645 "fix: unset CLAUDECODE in spawned sessions to prevent nested session errors"
- **Related PR:** #42 "feat: implement ao start command" (showed correct pattern)

---

## Conclusion

This bug was introduced during a well-intentioned refactoring that moved agent-specific logic into plugins. The two-method contract (`getLaunchCommand` + `getEnvironment`) was not explicitly documented or enforced, leading to an incomplete migration. The bug went undetected because tests mocked the agent plugin without verifying method calls, and manual testing didn't cover the orchestrator-spawning-workers scenario.

The fix is simple (call `getEnvironment()` and merge the env vars), but the prevention measures are more complex. The highest-priority fixes are:

1. Add integration tests that verify spawned agents actually start
2. Update unit tests to verify `getEnvironment()` is called
3. Add health checks that fail fast if agent doesn't start
4. Document the agent plugin contract explicitly
5. Add PR checklist for agent plugin changes

These measures will prevent similar issues in the future and catch integration problems earlier in the development cycle.
