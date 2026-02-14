/**
 * Integration tests for the Aider agent plugin.
 *
 * Requires:
 *   - `aider` binary on PATH
 *   - tmux installed and running
 *   - ANTHROPIC_API_KEY or OPENAI_API_KEY set (aider may open a browser if missing)
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
import aiderPlugin from "@agent-orchestrator/plugin-agent-aider";
import { isTmuxAvailable, killSessionsByPrefix, createSession, killSession } from "./helpers/tmux.js";
import { pollUntilEqual, sleep } from "./helpers/polling.js";
import { makeTmuxHandle, makeSession } from "./helpers/session-factory.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

const SESSION_PREFIX = "ao-inttest-aider-";

async function findAiderBinary(): Promise<string | null> {
  for (const bin of ["aider"]) {
    try {
      await execFileAsync("which", [bin], { timeout: 5_000 });
      return bin;
    } catch {
      // not found
    }
  }
  return null;
}

/**
 * Verify aider has a usable API key by running a quick smoke test inside
 * tmux (same context as the real test). A direct `execFileAsync` check
 * would inherit the vitest process's env, which may differ from tmux's.
 */
async function canAiderConnect(bin: string): Promise<boolean> {
  const probe = "ao-inttest-aider-probe";
  try {
    await killSessionsByPrefix(probe);
    await createSession(probe, `${bin} --exit --no-git --no-browser`, tmpdir());
    // Wait for the probe to finish (should take <10s if key is present)
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1_000));
      try {
        await execFileAsync("tmux", ["has-session", "-t", probe], { timeout: 5_000 });
        // session still exists — keep waiting
      } catch {
        // session is gone → aider exited cleanly
        return true;
      }
    }
    // Still running after 20s → stuck on auth prompt
    await killSession(probe);
    return false;
  } catch {
    return false;
  }
}

const tmuxOk = await isTmuxAvailable();
const aiderBin = await findAiderBinary();
const aiderReady = aiderBin !== null && (await canAiderConnect(aiderBin));
const canRun = tmuxOk && aiderReady;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)("agent-aider (integration)", () => {
  const agent = aiderPlugin.create();
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
    tmpDir = await mkdtemp(join(tmpdir(), "ao-inttest-aider-"));

    // --no-git avoids needing a git repo, --yes auto-accepts, --no-browser
    // prevents aider from opening the browser for auth (which would block).
    const cmd = `${aiderBin} --message 'Say hello and nothing else' --yes --no-auto-commits --no-git --no-browser`;
    await createSession(sessionName, cmd, tmpDir);

    const handle = makeTmuxHandle(sessionName);
    const session = makeSession("inttest-aider", handle, tmpDir);

    // Atomically capture "alive" observations. Aider has ~5s Python startup.
    const deadline = Date.now() + 25_000;
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

    // Wait for agent to exit — aider with --message should exit after responding
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

  it("getSessionInfo → null (not implemented for aider)", () => {
    expect(sessionInfo).toBeNull();
  });
});
