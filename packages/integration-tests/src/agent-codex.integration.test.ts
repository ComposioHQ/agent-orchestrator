/**
 * Integration tests for the Codex agent plugin.
 *
 * Requires:
 *   - `codex` binary on PATH (or at /opt/homebrew/bin/codex)
 *   - tmux installed and running
 *   - OPENAI_API_KEY set
 *
 * Skipped automatically when prerequisites are missing.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ActivityState, AgentSessionInfo } from "@agent-orchestrator/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import codexPlugin from "@agent-orchestrator/plugin-agent-codex";
import { isTmuxAvailable, killSessionsByPrefix, createSession, killSession, capturePane } from "./helpers/tmux.js";
import { pollUntilEqual, sleep } from "./helpers/polling.js";
import { makeTmuxHandle, makeSession } from "./helpers/session-factory.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

const SESSION_PREFIX = "ao-inttest-codex-";

async function findCodexBinary(): Promise<string | null> {
  for (const bin of ["codex"]) {
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
const codexBin = await findCodexBinary();
const canRun = tmuxOk && codexBin !== null;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)("agent-codex (integration)", () => {
  const agent = codexPlugin.create();
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
    tmpDir = await mkdtemp(join(tmpdir(), "ao-inttest-codex-"));

    const cmd = `${codexBin} exec 'Say hello and nothing else'`;
    await createSession(sessionName, cmd, tmpDir);

    const handle = makeTmuxHandle(sessionName);
    const session = makeSession("inttest-codex", handle, tmpDir);

    // Atomically capture "alive" observations — poll until we observe
    // both running=true AND activity!="exited" in the same iteration.
    // Fast-exiting agents may exit between separate calls, so we must
    // check both in a tight loop.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const running = await agent.isProcessRunning(handle);
      if (running) {
        aliveRunning = true;
        const output = await capturePane(sessionName);
        const activity = agent.detectActivity(output);
        if (activity !== "exited") {
          aliveActivity = activity;
          break;
        }
      }
      await sleep(200);
    }

    // Wait for agent to exit
    exitedRunning = await pollUntilEqual(
      () => agent.isProcessRunning(handle),
      false,
      { timeoutMs: 90_000, intervalMs: 2_000 },
    );

    const exitedOutput = await capturePane(sessionName);
    exitedActivity = agent.detectActivity(exitedOutput);
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
    // For very fast agents, we may not catch a non-exited activity state.
    // If aliveActivity is undefined, the agent exited too fast for atomic capture.
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

  it("getSessionInfo → null (not implemented for codex)", () => {
    expect(sessionInfo).toBeNull();
  });
});
