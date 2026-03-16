/**
 * Integration tests for the Gemini agent plugin.
 *
 * Requires:
 *   - `gemini` binary on PATH
 *   - tmux installed and running
 *   - GEMINI_API_KEY set
 *
 * Skipped automatically when prerequisites are missing.
 *
 * Task: write a fibonacci program to /tmp/ao-inttest-gemini-<ts>/fibonacci.py
 * and verify the file exists and produces correct output.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { findBinary, pollUntilEqual, sleep } from "./helpers/polling.js";
import { makeTmuxHandle, makeSession } from "./helpers/session-factory.js";

const execFileAsync = promisify(execFile);

const SESSION_PREFIX = "ao-inttest-gemini-";

const tmuxOk = await isTmuxAvailable();
const geminiBin = await findBinary(["gemini"]);
const python3Bin = await findBinary(["python3"]);
const hasApiKey = Boolean(process.env.GEMINI_API_KEY);
const canRun = tmuxOk && geminiBin !== null && hasApiKey && python3Bin !== null;

describe.skipIf(!canRun)("agent-gemini (integration)", () => {
  const agent = geminiPlugin.create();
  const sessionName = `${SESSION_PREFIX}${Date.now()}`;
  let tmpDir: string;
  let outputFile: string;

  let aliveRunning = false;
  let exitedRunning: boolean;
  let fileCreated = false;

  beforeAll(async () => {
    await killSessionsByPrefix(SESSION_PREFIX);
    tmpDir = await mkdtemp(join(tmpdir(), "ao-inttest-gemini-"));
    outputFile = join(tmpDir, "fibonacci.py");

    const task = `Write a Python fibonacci program to the file fibonacci.py. The program should print the first 10 fibonacci numbers when run. Write only the file, no explanation.`;
    // --yolo skips all permission prompts; -p runs in one-shot (non-interactive) mode.
    const cmd = `${geminiBin} --yolo -p '${task}'`;
    // GEMINI_API_KEY is sourced from ~/.zshenv, which tmux/zsh sessions pick up automatically.
    await createSession(sessionName, cmd, tmpDir);

    const handle = makeTmuxHandle(sessionName);
    const _session = makeSession("inttest-gemini", handle, tmpDir);

    // Poll until running using pollUntilEqual for more reliable detection
    aliveRunning = await pollUntilEqual(() => agent.isProcessRunning(handle), true, {
      timeoutMs: 30_000,
      intervalMs: 1_000,
    }).catch(() => false);

    // Wait for agent to exit (up to 2 min)
    exitedRunning = await pollUntilEqual(() => agent.isProcessRunning(handle), false, {
      timeoutMs: 120_000,
      intervalMs: 2_000,
    });

    // Check file was created
    try {
      await access(outputFile);
      fileCreated = true;
    } catch {
      fileCreated = false;
    }
  }, 150_000);

  afterAll(async () => {
    await killSession(sessionName);
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it("isProcessRunning → true while agent is alive", () => {
    expect(aliveRunning).toBe(true);
  });

  it("isProcessRunning → false after agent exits", () => {
    expect(exitedRunning).toBe(false);
  });

  it("fibonacci.py created in output dir", () => {
    expect(fileCreated).toBe(true);
  });

  it("fibonacci.py runs and outputs correct fibonacci numbers", async () => {
    // Rely on previous test to verify fileCreated; if we get here and file doesn't exist, let it throw
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
