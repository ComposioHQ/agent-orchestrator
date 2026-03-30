/**
 * Integration tests for the Gemini agent plugin.
 *
 * Requires:
 *   - `gemini` binary on PATH
 *   - tmux installed and running
 *   - Gemini CLI authenticated (OAuth via `gemini` login or GEMINI_API_KEY)
 *
 * Skipped automatically when prerequisites are missing.
 *
 * Task: write a fibonacci program to /tmp/ao-inttest-gemini-<ts>/fibonacci.py
 * and verify the file exists and produces correct output.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import geminiPlugin from "@composio/ao-plugin-agent-gemini";
import {
  isTmuxAvailable,
  killSessionsByPrefix,
  createSession,
  killSession,
} from "./helpers/tmux.js";
import { findBinary, pollUntilEqual } from "./helpers/polling.js";
import { makeTmuxHandle, makeSession } from "./helpers/session-factory.js";

const execFileAsync = promisify(execFile);

const SESSION_PREFIX = "ao-inttest-gemini-";

async function isGeminiAuthenticated(): Promise<boolean> {
  // OAuth credentials file is present when logged in via `gemini` OAuth flow.
  try {
    await access(join(homedir(), ".gemini", "oauth_creds.json"));
    return true;
  } catch {
    // Fall back to API key
    return !!process.env.GEMINI_API_KEY;
  }
}

const tmuxOk = await isTmuxAvailable();
const geminiBin = await findBinary(["gemini"]);
const python3Bin = await findBinary(["python3"]);
const geminiAuthed = geminiBin !== null && (await isGeminiAuthenticated());
const canRun = tmuxOk && geminiBin !== null && geminiAuthed && python3Bin !== null;

describe.skipIf(!canRun)("agent-gemini (integration)", () => {
  const agent = geminiPlugin.create();
  const sessionName = `${SESSION_PREFIX}${Date.now()}`;
  let tmpDir: string;
  let outputFile: string;

  let aliveRunning = false;
  let aliveActivityState: Awaited<ReturnType<typeof agent.getActivityState>>;
  let aliveSessionInfo: Awaited<ReturnType<typeof agent.getSessionInfo>>;
  let exitedRunning: boolean;
  let exitedActivityState: Awaited<ReturnType<typeof agent.getActivityState>>;
  let exitedSessionInfo: Awaited<ReturnType<typeof agent.getSessionInfo>>;
  let fileCreated = false;

  beforeAll(async () => {
    await killSessionsByPrefix(SESSION_PREFIX);
    tmpDir = await mkdtemp(join(tmpdir(), "ao-inttest-gemini-"));
    outputFile = join(tmpDir, "fibonacci.py");

    const task = `Write a Python fibonacci program to the file fibonacci.py. The program should print the first 10 fibonacci numbers when run. Write only the file, no explanation.`;
    // --yolo skips all permission prompts; -p runs in one-shot (non-interactive) mode.
    // --allowed-mcp-server-names with a non-existent name skips all MCP server loading,
    // which otherwise adds ~60s of startup latency per run (all MCP servers load on init).
    // Forward auth env vars so the tmux session uses the same Google Cloud project as
    // the test runner (the tmux server may have a stale GOOGLE_CLOUD_PROJECT that does
    // not have cloudaicompanion.googleapis.com enabled, causing OAuth 403 errors).
    // Pass task via $TASK env var to avoid shell quoting / injection issues.
    const cmd = `${geminiBin} --yolo --allowed-mcp-server-names _ao_inttest_no_mcp -p "$TASK"`;
    const sessionEnv: Record<string, string> = { TASK: task };
    for (const key of ["GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_PROJECT_ID"]) {
      if (process.env[key]) sessionEnv[key] = process.env[key]!;
    }
    await createSession(sessionName, cmd, tmpDir, sessionEnv);

    const handle = makeTmuxHandle(sessionName);
    const session = makeSession("inttest-gemini", handle, tmpDir);

    // Poll until running using pollUntilEqual for more reliable detection
    aliveRunning = await pollUntilEqual(() => agent.isProcessRunning(handle), true, {
      timeoutMs: 30_000,
      intervalMs: 1_000,
    }).catch(() => false);

    // Capture activity state while alive (Gemini uses .json session files)
    if (aliveRunning) {
      aliveActivityState = await agent.getActivityState(session);
      aliveSessionInfo = await agent.getSessionInfo(session);
    }

    // Wait for agent to exit (up to 3 min — Gemini loads MCPs before executing, adding ~60s startup)
    exitedRunning = await pollUntilEqual(() => agent.isProcessRunning(handle), false, {
      timeoutMs: 180_000,
      intervalMs: 2_000,
    });

    // Capture activity state after exit
    exitedActivityState = await agent.getActivityState(session);
    exitedSessionInfo = await agent.getSessionInfo(session);

    // Check file was created
    try {
      await access(outputFile);
      fileCreated = true;
    } catch {
      fileCreated = false;
    }
  }, 220_000);

  afterAll(async () => {
    await killSession(sessionName);
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it("isProcessRunning → true while agent is alive", () => {
    expect(aliveRunning).toBe(true);
  });

  it("getActivityState → returns valid state while running (Gemini uses .json session files)", () => {
    // Gemini writes .json session files - activity detection should work
    expect(aliveActivityState).toBeDefined();
    expect(aliveActivityState?.state).not.toBe("exited");
    expect([null, "active", "ready", "idle", "waiting_input", "blocked"]).toContain(
      aliveActivityState?.state ?? null,
    );
  });

  it("getSessionInfo → returns session data while running (or null if path mismatch)", () => {
    // Session info may be null if session dir path encoding doesn't match
    if (aliveSessionInfo !== null) {
      expect(aliveSessionInfo).toHaveProperty("summary");
    }
  });

  it("isProcessRunning → false after agent exits", () => {
    expect(exitedRunning).toBe(false);
  });

  it("getActivityState → returns exited after agent terminates", () => {
    expect(exitedActivityState?.state).toBe("exited");
  });

  it("getSessionInfo → returns session data after exit (or null if path mismatch)", () => {
    if (exitedSessionInfo !== null) {
      expect(exitedSessionInfo).toHaveProperty("summary");
    }
  });

  it("fibonacci.py created in output dir", () => {
    expect(fileCreated).toBe(true);
  });

  it("fibonacci.py runs and outputs correct fibonacci numbers", async () => {
    expect(fileCreated).toBe(true);
    const { stdout } = await execFileAsync(python3Bin!, ["-I", outputFile], {
      timeout: 10_000,
      env: { PATH: process.env.PATH ?? "" },
    });
    const numbers = stdout.trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
    expect(numbers.length).toBeGreaterThanOrEqual(10);
    // First 10 fibonacci numbers
    expect(numbers.slice(0, 10)).toEqual([0, 1, 1, 2, 3, 5, 8, 13, 21, 34]);
  });
});
