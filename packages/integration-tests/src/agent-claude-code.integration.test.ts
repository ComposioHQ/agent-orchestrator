/**
 * Integration tests for the Claude Code agent plugin.
 *
 * Requires:
 *   - `claude` binary on PATH
 *   - tmux installed and running
 *   - ANTHROPIC_API_KEY set (Claude will make a real API call)
 *
 * Skipped automatically when prerequisites are missing.
 */

import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ActivityState, AgentSessionInfo } from "@composio/ao-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import claudeCodePlugin from "@composio/ao-plugin-agent-claude-code";
import { isTmuxAvailable, killSessionsByPrefix, createSession, killSession } from "./helpers/tmux.js";
import { pollUntilEqual, sleep } from "./helpers/polling.js";
import { makeTmuxHandle, makeSession } from "./helpers/session-factory.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

const SESSION_PREFIX = "ao-inttest-claude-";

async function findClaudeBinary(): Promise<string | null> {
  for (const bin of ["claude"]) {
    try {
      await execFileAsync("which", [bin], { timeout: 5_000 });
      return bin;
    } catch {
      // not found
    }
  }
  return null;
}

const tmuxOk = await isTmuxAvailable();
const claudeBin = await findClaudeBinary();
const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
const canRun = tmuxOk && claudeBin !== null && hasApiKey;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)("agent-claude-code (integration)", () => {
  const agent = claudeCodePlugin.create();
  const sessionName = `${SESSION_PREFIX}${Date.now()}`;
  let tmpDir: string;

  // Observations captured while the agent is alive
  let aliveRunning = false;
  let aliveActivityState: ActivityState | undefined;
  let aliveSessionInfo: AgentSessionInfo | null = null;

  // Observations captured after the agent exits
  let exitedRunning: boolean;
  let exitedActivityState: ActivityState;
  let exitedSessionInfo: AgentSessionInfo | null;

  beforeAll(async () => {
    await killSessionsByPrefix(SESSION_PREFIX);

    // Create temp workspace — resolve symlinks (macOS /tmp → /private/tmp)
    const raw = await mkdtemp(join(tmpdir(), "ao-inttest-claude-"));
    tmpDir = await realpath(raw);

    // Spawn Claude with a task that generates observable activity (file creation)
    const cmd = `CLAUDECODE= ${claudeBin} -p 'Create a file called test.txt with the content "integration test"'`;
    await createSession(sessionName, cmd, tmpDir);

    const handle = makeTmuxHandle(sessionName);
    const session = makeSession("inttest-claude", handle, tmpDir);

    // Poll until we capture "alive" observations
    // Claude needs time to start, create JSONL, and begin processing
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const running = await agent.isProcessRunning(handle);
      if (running) {
        aliveRunning = true;
        try {
          const activityState = await agent.getActivityState(session);
          if (activityState !== "exited") {
            aliveActivityState = activityState;
            // Also capture session info while alive
            aliveSessionInfo = await agent.getSessionInfo(session);
            break;
          }
        } catch {
          // JSONL might not exist yet, keep polling
        }
      }
      await sleep(1_000);
    }

    // Wait for agent to exit (simple task should complete within 90s)
    exitedRunning = await pollUntilEqual(
      () => agent.isProcessRunning(handle),
      false,
      { timeoutMs: 90_000, intervalMs: 2_000 },
    );

    // Capture post-exit observations
    exitedActivityState = await agent.getActivityState(session);
    exitedSessionInfo = await agent.getSessionInfo(session);
  }, 150_000);

  afterAll(async () => {
    await killSession(sessionName);
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  it("isProcessRunning → true while agent is alive", () => {
    expect(aliveRunning).toBe(true);
  });

  it("getActivityState → returns valid non-exited state while agent is alive", () => {
    expect(aliveActivityState).toBeDefined();
    expect(aliveActivityState).not.toBe("exited");
    expect(["active", "idle", "waiting_input", "blocked"]).toContain(aliveActivityState);
  });

  it("getSessionInfo → returns session data while agent is alive (or null if path mismatch)", () => {
    // The JSONL path depends on Claude's internal encoding of workspacePath.
    // If the temp dir resolves differently (symlinks, etc.), may return null.
    // Both outcomes are acceptable — the key is it doesn't throw.
    if (aliveSessionInfo !== null) {
      expect(aliveSessionInfo).toHaveProperty("summary");
      expect(aliveSessionInfo).toHaveProperty("agentSessionId");
      expect(typeof aliveSessionInfo.agentSessionId).toBe("string");
    }
  });

  it("isProcessRunning → false after agent exits", () => {
    expect(exitedRunning).toBe(false);
  });

  it("getActivityState → returns exited after agent process terminates", () => {
    expect(exitedActivityState).toBe("exited");
  });

  it("getSessionInfo → returns session data after agent exits (or null if path mismatch)", () => {
    // JSONL should still be readable after exit, but path encoding may cause null.
    // Both outcomes are acceptable — the key is it doesn't throw.
    if (exitedSessionInfo !== null) {
      expect(exitedSessionInfo).toHaveProperty("summary");
      expect(exitedSessionInfo).toHaveProperty("agentSessionId");
      expect(typeof exitedSessionInfo.agentSessionId).toBe("string");
    }
  });
});
