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
import type { ActivityState, AgentSessionInfo } from "@composio/ao-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import codexPlugin from "@composio/ao-plugin-agent-codex";
import { isTmuxAvailable, killSessionsByPrefix, createSession, killSession } from "./helpers/tmux.js";
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
const hasApiKey = Boolean(process.env.OPENAI_API_KEY);
const canRun = tmuxOk && codexBin !== null && hasApiKey;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)("agent-codex (integration)", () => {
  const agent = codexPlugin.create();
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
    tmpDir = await mkdtemp(join(tmpdir(), "ao-inttest-codex-"));

    const cmd = `${codexBin} exec 'Say hello and nothing else'`;
    await createSession(sessionName, cmd, tmpDir);

    const handle = makeTmuxHandle(sessionName);
    const session = makeSession("inttest-codex", handle, tmpDir);

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
    // Codex uses conservative fallback: returns "active" when process is running
    // (due to global rollout file storage without per-session scoping)
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

  it("getSessionInfo → null (not implemented for codex)", () => {
    expect(sessionInfo).toBeNull();
  });
});
