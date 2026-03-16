/**
 * Integration tests for the Cursor agent plugin.
 *
 * Requires:
 *   - `cursor-agent` binary on PATH
 *   - tmux installed and running
 *   - cursor-agent authenticated (via `cursor-agent login`)
 *
 * Skipped automatically when prerequisites are missing.
 *
 * Task: write a fibonacci program to /tmp/ao-inttest-cursor-<ts>/fibonacci.py
 * and verify the file exists and produces correct output.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import cursorPlugin from "@composio/ao-plugin-agent-cursor";
import {
  isTmuxAvailable,
  killSessionsByPrefix,
  createSession,
  killSession,
} from "./helpers/tmux.js";
import { findBinary, pollUntilEqual } from "./helpers/polling.js";
import { makeTmuxHandle, makeSession } from "./helpers/session-factory.js";

const execFileAsync = promisify(execFile);

const SESSION_PREFIX = "ao-inttest-cursor-";

async function isCursorAuthenticated(bin: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(bin, ["status"], { timeout: 10_000 });
    return stdout.includes("Logged in");
  } catch {
    return false;
  }
}

const tmuxOk = await isTmuxAvailable();
const cursorBin = await findBinary(["cursor-agent"]);
const python3Bin = await findBinary(["python3"]);
const cursorAuthed = cursorBin !== null && (await isCursorAuthenticated(cursorBin));
const canRun = tmuxOk && cursorBin !== null && cursorAuthed && python3Bin !== null;

describe.skipIf(!canRun)("agent-cursor (integration)", () => {
  const agent = cursorPlugin.create();
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
    tmpDir = await mkdtemp(join(tmpdir(), "ao-inttest-cursor-"));
    outputFile = join(tmpDir, "fibonacci.py");

    const task = `Write a Python fibonacci program to the file fibonacci.py. The program should print the first 10 fibonacci numbers when run. Write only the file, no explanation.`;
    // --force allows file writes without interactive confirmation (cursor plugin's permissionlessFlag).
    // --print runs non-interactively, exits when done.
    // Pass task as direct argument (not via printf %q which double-escapes).
    const cmd = `${cursorBin} --print --force "${task}"`;
    await createSession(sessionName, cmd, tmpDir);

    const handle = makeTmuxHandle(sessionName);
    const session = makeSession("inttest-cursor", handle, tmpDir);

    // Poll until running using pollUntilEqual for more reliable detection
    aliveRunning = await pollUntilEqual(() => agent.isProcessRunning(handle), true, {
      timeoutMs: 30_000,
      intervalMs: 1_000,
    }).catch(() => false);

    // Capture activity state while alive (Cursor uses SQLite, not JSONL - returns null)
    if (aliveRunning) {
      aliveActivityState = await agent.getActivityState(session);
      aliveSessionInfo = await agent.getSessionInfo(session);
    }

    // Wait for agent to exit (up to 3 min — cursor can be slow on first cold start)
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
  }, 210_000);

  afterAll(async () => {
    await killSession(sessionName);
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it("isProcessRunning → true while agent is alive", () => {
    expect(aliveRunning).toBe(true);
  });

  it("getActivityState → returns null while running (Cursor uses SQLite, not JSONL)", () => {
    // Cursor stores sessions in SQLite, not JSONL. Activity detection via JSONL returns null.
    expect(aliveActivityState).toBeNull();
  });

  it("getSessionInfo → returns null (no JSONL session files)", () => {
    // Cursor doesn't write JSONL session files - it uses SQLite internally
    expect(aliveSessionInfo).toBeNull();
  });

  it("isProcessRunning → false after agent exits", () => {
    expect(exitedRunning).toBe(false);
  });

  it("getActivityState → returns exited after agent terminates", () => {
    expect(exitedActivityState?.state).toBe("exited");
  });

  it("getSessionInfo → returns null after exit (no JSONL session files)", () => {
    expect(exitedSessionInfo).toBeNull();
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
