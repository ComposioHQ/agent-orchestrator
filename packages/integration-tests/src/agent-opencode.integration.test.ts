/**
 * Integration tests for the OpenCode agent plugin.
 *
 * Requires:
 *   - `opencode` binary on PATH
 *   - tmux installed and running
 *   - ANTHROPIC_API_KEY or OPENAI_API_KEY set
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
import opencodePlugin from "@agent-orchestrator/plugin-agent-opencode";
import { isTmuxAvailable, killSessionsByPrefix, createSession, killSession, capturePane } from "./helpers/tmux.js";
import { pollUntilEqual, sleep } from "./helpers/polling.js";
import { makeTmuxHandle, makeSession } from "./helpers/session-factory.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

const SESSION_PREFIX = "ao-inttest-opencode-";

async function findOpencodeBinary(): Promise<string | null> {
  try {
    await execFileAsync("which", ["opencode"], { timeout: 5_000 });
    return "opencode";
  } catch {
    return null;
  }
}

/** Verify opencode can start (has API key, binary works). */
async function canOpencodeRun(bin: string): Promise<boolean> {
  const probe = "ao-inttest-opencode-probe";
  try {
    await killSessionsByPrefix(probe);
    // Run a trivial prompt — opencode run exits after completing
    await createSession(probe, `${bin} run 'Say hello'`, tmpdir());
    // Wait for the probe to finish (should exit within ~15s)
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1_000));
      try {
        await execFileAsync("tmux", ["has-session", "-t", probe], { timeout: 5_000 });
      } catch {
        // session is gone -> opencode exited cleanly
        return true;
      }
    }
    // Still running after 20s -> possibly stuck
    await killSession(probe);
    return false;
  } catch {
    return false;
  }
}

const tmuxOk = await isTmuxAvailable();
const opencodeBin = await findOpencodeBinary();
const opencodeReady = opencodeBin !== null && (await canOpencodeRun(opencodeBin));
const canRun = tmuxOk && opencodeReady;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)("agent-opencode (integration)", () => {
  const agent = opencodePlugin.create();
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
    tmpDir = await mkdtemp(join(tmpdir(), "ao-inttest-opencode-"));

    const cmd = `${opencodeBin} run 'Say hello and nothing else'`;
    await createSession(sessionName, cmd, tmpDir);

    const handle = makeTmuxHandle(sessionName);
    const session = makeSession("inttest-opencode", handle, tmpDir);

    // Atomically capture "alive" observations
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

  it("getSessionInfo → null (not implemented for opencode)", () => {
    expect(sessionInfo).toBeNull();
  });
});
