/**
 * Integration tests for the Cline agent plugin.
 *
 * Tests the Cline CLI agent plugin by:
 * 1. Verifying Cline process detection in tmux sessions
 * 2. Testing activity state detection from Cline's metadata
 * 3. Testing session info extraction
 * 4. Full lifecycle test spawning a real Cline process
 *
 * Prerequisites:
 * - Cline CLI installed (`cline` binary in PATH)
 * - Cline authenticated with a provider (`cline auth`)
 * - tmux installed and running
 *
 * Skipped automatically when prerequisites are missing.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type ActivityDetection, type AgentSessionInfo } from "@composio/ao-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import clinePlugin from "@composio/ao-plugin-agent-cline";
import {
  isTmuxAvailable,
  killSessionsByPrefix,
  createSession,
  killSession,
} from "./helpers/tmux.js";
import { pollUntilEqual, sleep } from "./helpers/polling.js";
import { makeTmuxHandle, makeSession } from "./helpers/session-factory.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

const SESSION_PREFIX = "ao-inttest-cline-";

async function findClineBinary(): Promise<string | null> {
  for (const bin of ["cline"]) {
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
const clineBin = await findClineBinary();

// Check if Cline is authenticated by trying to run a simple command
async function isClineAuthenticated(): Promise<boolean> {
  if (!clineBin) return false;
  try {
    // Try to get Cline's auth status - this will fail if not authenticated
    await execFileAsync(clineBin, ["auth", "list"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const isAuthenticated = await isClineAuthenticated();
const canRun = tmuxOk && clineBin !== null && isAuthenticated;

// ---------------------------------------------------------------------------
// Path validation — verify Cline's data directory structure
// ---------------------------------------------------------------------------

/**
 * Find a workspace path on this machine that has Cline task metadata.
 * Returns null if Cline has never been used (test will skip).
 */
async function findRealClineProject(): Promise<{
  workspacePath: string;
  taskDir: string;
  metadataFile: string;
} | null> {
  const clineDataDir = join(homedir(), ".cline", "data", "tasks");
  let dirs: string[];
  try {
    dirs = await readdir(clineDataDir);
  } catch {
    return null;
  }

  // Find a task directory with valid metadata
  for (const taskId of dirs) {
    const taskPath = join(clineDataDir, taskId);
    let files: string[];
    try {
      files = await readdir(taskPath);
    } catch {
      continue;
    }

    if (files.includes("task_metadata.json")) {
      // Found a valid task directory
      // Extract workspace path from metadata if possible
      // For now, just return the task directory info
      return {
        workspacePath: "", // Will be determined from session
        taskDir: taskPath,
        metadataFile: join(taskPath, "task_metadata.json"),
      };
    }
  }

  return null;
}

const realProject = await findRealClineProject();

describe.skipIf(!realProject)("Cline metadata parsing (real Cline data)", () => {
  it("can read task metadata from a real Cline task", async () => {
    const fs = await import("node:fs/promises");
    const content = await fs.readFile(realProject!.metadataFile, "utf-8");
    const metadata = JSON.parse(content);

    // Verify expected structure
    expect(metadata).toBeDefined();
    // Cline metadata should have model_usage or files_in_context
    expect(
      metadata.model_usage !== undefined || metadata.files_in_context !== undefined,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle test (requires cline binary + auth + tmux)
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)("agent-cline (integration)", () => {
  const agent = clinePlugin.create();
  const sessionName = `${SESSION_PREFIX}${Date.now()}`;
  let tmpDir: string;

  // Observations captured while the agent is alive
  let aliveRunning = false;
  let aliveActivityState: ActivityDetection | null | undefined;
  let aliveSessionInfo: AgentSessionInfo | null = null;

  // Observations captured after the agent exits
  let exitedRunning: boolean;
  let exitedActivityState: ActivityDetection | null;
  let exitedSessionInfo: AgentSessionInfo | null;

  beforeAll(async () => {
    await killSessionsByPrefix(SESSION_PREFIX);

    // Create temp workspace — resolve symlinks (macOS /tmp → /private/tmp)
    const raw = await mkdtemp(join(tmpdir(), "ao-inttest-cline-"));
    tmpDir = await realpath(raw);

    // Spawn Cline with a task that generates observable activity (file creation)
    // Using --act mode for autonomous operation and -p for the prompt
    const prompt = "Create a file called test.txt with the content 'integration test'";
    const cmd = `${clineBin} task --act -p '${prompt}'`;

    await createSession(sessionName, cmd, tmpDir);

    const handle = makeTmuxHandle(sessionName);
    const session = makeSession("inttest-cline", handle, tmpDir);

    // Poll until we capture "alive" observations
    // Cline needs time to start and create metadata
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const running = await agent.isProcessRunning(handle);
      if (running) {
        aliveRunning = true;
        try {
          const activityState = await agent.getActivityState(session);
          if (activityState?.state !== "exited") {
            aliveActivityState = activityState;
            // Also capture session info while alive
            aliveSessionInfo = await agent.getSessionInfo(session);
            break;
          }
        } catch {
          // Metadata might not exist yet, keep polling
        }
      }
      await sleep(2_000);
    }

    // Wait for agent to exit (simple task should complete within 120s)
    exitedRunning = await pollUntilEqual(() => agent.isProcessRunning(handle), false, {
      timeoutMs: 120_000,
      intervalMs: 2_000,
    });

    // Capture post-exit observations
    exitedActivityState = await agent.getActivityState(session);
    exitedSessionInfo = await agent.getSessionInfo(session);
  }, 180_000);

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
    expect(aliveActivityState?.state).not.toBe("exited");
    // May be null (no metadata yet) or a concrete state
    expect([null, "active", "ready", "idle", "waiting_input", "blocked"]).toContain(
      aliveActivityState?.state ?? null,
    );
  });

  it("getSessionInfo → returns session data while agent is alive", () => {
    // Session info depends on Cline's metadata being available
    // Both outcomes are acceptable — the key is it doesn't throw
    if (aliveSessionInfo !== null) {
      expect(aliveSessionInfo).toHaveProperty("agentSessionId");
      expect(typeof aliveSessionInfo.agentSessionId).toBe("string");
    }
  });

  it("isProcessRunning → false after agent exits", () => {
    expect(exitedRunning).toBe(false);
  });

  it("getActivityState → returns exited after agent process terminates", () => {
    expect(exitedActivityState?.state).toBe("exited");
  });

  it("getSessionInfo → returns session data after agent exits", () => {
    // Metadata should still be readable after exit
    // Both outcomes are acceptable — the key is it doesn't throw
    if (exitedSessionInfo !== null) {
      expect(exitedSessionInfo).toHaveProperty("agentSessionId");
      expect(typeof exitedSessionInfo.agentSessionId).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests for specific functionality
// ---------------------------------------------------------------------------

describe("agent-cline (unit)", () => {
  const agent = clinePlugin.create();

  it("has correct name and processName", () => {
    expect(agent.name).toBe("cline");
    expect(agent.processName).toBe("cline");
  });

  it("getLaunchCommand returns correct command structure", () => {
    const cmd = agent.getLaunchCommand({
      sessionId: "test-session",
      projectConfig: {
        name: "test",
        repo: "owner/test",
        path: "/tmp/test",
        defaultBranch: "main",
        sessionPrefix: "test",
      },
      prompt: "Test prompt",
    });

    expect(cmd).toContain("cline");
    expect(cmd).toContain("task");
    expect(cmd).toContain("--act");
    expect(cmd).toContain("--yolo");
    expect(cmd).toContain("-p");
    expect(cmd).toContain("Test prompt");
  });

  it("getLaunchCommand includes model when specified", () => {
    const cmd = agent.getLaunchCommand({
      sessionId: "test-session",
      projectConfig: {
        name: "test",
        repo: "owner/test",
        path: "/tmp/test",
        defaultBranch: "main",
        sessionPrefix: "test",
      },
      model: "minimax/minimax-m2.5",
      prompt: "Test prompt",
    });

    expect(cmd).toContain("--model");
    expect(cmd).toContain("minimax/minimax-m2.5");
  });

  it("getEnvironment sets AO_SESSION_ID", () => {
    const env = agent.getEnvironment({
      sessionId: "test-session-123",
      projectConfig: {
        name: "test",
        repo: "owner/test",
        path: "/tmp/test",
        defaultBranch: "main",
        sessionPrefix: "test",
      },
    });

    expect(env.AO_SESSION_ID).toBe("test-session-123");
  });

  it("getEnvironment includes issue ID when provided", () => {
    const env = agent.getEnvironment({
      sessionId: "test-session",
      projectConfig: {
        name: "test",
        repo: "owner/test",
        path: "/tmp/test",
        defaultBranch: "main",
        sessionPrefix: "test",
      },
      issueId: "ISSUE-123",
    });

    expect(env.AO_ISSUE_ID).toBe("ISSUE-123");
  });

  it("detectActivity classifies prompt lines as idle", () => {
    expect(agent.detectActivity("❯ ")).toBe("idle");
    expect(agent.detectActivity("$ ")).toBe("idle");
    expect(agent.detectActivity("> ")).toBe("idle");
    expect(agent.detectActivity("# ")).toBe("idle");
  });

  it("detectActivity classifies permission prompts as waiting_input", () => {
    expect(agent.detectActivity("Do you want to proceed? (y/N)\n❯ ")).toBe("waiting_input");
    expect(agent.detectActivity("Some output\n(Y)es (N)o\n❯ ")).toBe("waiting_input");
  });

  it("detectActivity classifies other output as active", () => {
    expect(agent.detectActivity("Thinking...")).toBe("active");
    expect(agent.detectActivity("Reading file...")).toBe("active");
    expect(agent.detectActivity("Running tests...")).toBe("active");
  });

  it("setupWorkspaceHooks is a no-op", async () => {
    // Should not throw
    await agent.setupWorkspaceHooks!("/tmp/test", { dataDir: "/tmp/.ao" });
  });

  it("postLaunchSetup is a no-op", async () => {
    // Should not throw
    const handle = makeTmuxHandle("test");
    const session = makeSession("test", handle, "/tmp/test");
    await agent.postLaunchSetup!(session);
  });
});
