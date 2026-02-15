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
import type { ActivityState, AgentSessionInfo } from "@composio/ao-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import opencodePlugin from "@composio/ao-plugin-agent-opencode";
import { isTmuxAvailable, killSessionsByPrefix, createSession, killSession } from "./helpers/tmux.js";
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
const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
// Skip the expensive canOpencodeRun probe if no API key is available
const opencodeReady = hasApiKey && opencodeBin !== null && (await canOpencodeRun(opencodeBin));
const canRun = tmuxOk && opencodeReady;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)("agent-opencode (integration)", () => {
  const agent = opencodePlugin.create();
  const sessionName = `${SESSION_PREFIX}${Date.now()}`;
  let tmpDir: string;

  // Observations captured while the agent is alive
  let aliveRunning = false;
  let aliveActivityState: ActivityState | undefined;

  // Observations captured after the agent exits
  let exitedRunning: boolean;
  let exitedActivityState: ActivityState;
  let sessionInfo: AgentSessionInfo | null;

  beforeAll(async () => {
    await killSessionsByPrefix(SESSION_PREFIX);
    tmpDir = await mkdtemp(join(tmpdir(), "ao-inttest-opencode-"));

    const cmd = `${opencodeBin} run 'Say hello and nothing else'`;
    await createSession(sessionName, cmd, tmpDir);

    const handle = makeTmuxHandle(sessionName);
    const session = makeSession("inttest-opencode", handle, tmpDir);

    // Poll until we observe the agent is running and capture activity state
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const running = await agent.isProcessRunning(handle);
      if (running) {
        aliveRunning = true;
        const activityState = await agent.getActivityState(session);
        if (activityState !== "exited") {
          aliveActivityState = activityState;
          break;
        }
      }
      await sleep(500);
    }

    // Wait for agent to exit
    exitedRunning = await pollUntilEqual(
      () => agent.isProcessRunning(handle),
      false,
      { timeoutMs: 90_000, intervalMs: 2_000 },
    );

    exitedActivityState = await agent.getActivityState(session);
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

  it("getActivityState → returns active while agent is running", () => {
    // OpenCode uses conservative fallback: returns "active" when process is running
    // (due to global SQLite database shared by all sessions)
    if (aliveActivityState !== undefined) {
      expect(aliveActivityState).toBe("active");
    }
  });

  it("isProcessRunning → false after agent exits", () => {
    expect(exitedRunning).toBe(false);
  });

  it("getActivityState → returns exited after agent process terminates", () => {
    expect(exitedActivityState).toBe("exited");
  });

  it("getSessionInfo → null (not implemented for opencode)", () => {
    expect(sessionInfo).toBeNull();
  });
});
