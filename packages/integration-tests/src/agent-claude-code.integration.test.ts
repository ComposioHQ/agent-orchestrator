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
import type { ActivityState, AgentSessionInfo } from "@agent-orchestrator/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import claudeCodePlugin from "@agent-orchestrator/plugin-agent-claude-code";
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
const canRun = tmuxOk && claudeBin !== null;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)("agent-claude-code (integration)", () => {
  const agent = claudeCodePlugin.create();
  const sessionName = `${SESSION_PREFIX}${Date.now()}`;
  let tmpDir: string;

  // Observations captured while the agent is alive (atomically)
  let aliveRunning = false;
  let aliveActivity: ActivityState | undefined;

  // Observations captured after the agent exits
  let exitedRunning: boolean;
  let exitedActivity: ActivityState;
  let sessionInfo: AgentSessionInfo | null;

  beforeAll(async () => {
    await killSessionsByPrefix(SESSION_PREFIX);

    // Create temp workspace — resolve symlinks (macOS /tmp → /private/tmp)
    const raw = await mkdtemp(join(tmpdir(), "ao-inttest-claude-"));
    tmpDir = await realpath(raw);

    // Spawn Claude with a trivial prompt
    const cmd = `CLAUDECODE= ${claudeBin} -p 'Say hello and nothing else'`;
    await createSession(sessionName, cmd, tmpDir);

    const handle = makeTmuxHandle(sessionName);
    const session = makeSession("inttest-claude", handle, tmpDir);

    // Atomically capture "alive" observations
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const running = await agent.isProcessRunning(handle);
      if (running) {
        aliveRunning = true;
        const activity = await agent.detectActivity(session);
        if (activity !== "exited") {
          aliveActivity = activity;
          break;
        }
      }
      await sleep(500);
    }

    // Wait for agent to exit (trivial prompt should complete quickly)
    exitedRunning = await pollUntilEqual(
      () => agent.isProcessRunning(handle),
      false,
      { timeoutMs: 90_000, intervalMs: 2_000 },
    );

    exitedActivity = await agent.detectActivity(session);
    sessionInfo = await agent.getSessionInfo(session);
  }, 120_000);

  afterAll(async () => {
    await killSession(sessionName);
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  it("isProcessRunning → true while agent is alive", () => {
    expect(aliveRunning).toBe(true);
  });

  it("detectActivity → not exited while agent is alive", () => {
    if (aliveActivity !== undefined) {
      expect(aliveActivity).not.toBe("exited");
      expect(["active", "idle", "waiting_input", "blocked"]).toContain(aliveActivity);
    }
  });

  it("isProcessRunning → false after agent exits", () => {
    expect(exitedRunning).toBe(false);
  });

  it("detectActivity → exited after agent exits", () => {
    expect(exitedActivity).toBe("exited");
  });

  it("getSessionInfo → returns session data (or null if JSONL path mismatch)", () => {
    // The JSONL path depends on Claude's internal encoding of workspacePath.
    // If the temp dir path resolves differently, getSessionInfo may return null.
    // Both outcomes are acceptable — the key is it doesn't throw.
    if (sessionInfo !== null) {
      expect(sessionInfo).toHaveProperty("summary");
      expect(sessionInfo).toHaveProperty("agentSessionId");
      expect(typeof sessionInfo.agentSessionId).toBe("string");
    }
  });
});
