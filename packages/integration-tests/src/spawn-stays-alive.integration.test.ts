/**
 * Integration test: spawn pipeline keeps agent alive.
 *
 * Validates the fix for the `-p` (one-shot exit) bug. Wires a stub agent
 * through the REAL sessionManager.spawn() → tmux runtime pipeline, verifying:
 *   1. The spawned process stays alive (not one-shot exit)
 *   2. Metadata is written with status=working
 *   3. Session can be killed and cleaned up
 *
 * Requires: tmux installed and running.
 * Does NOT require: Claude Code binary, API keys, or git repos.
 */

import { mkdtemp, rm, realpath, readFile } from "node:fs/promises";
import { writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import tmuxPlugin from "@composio/ao-plugin-runtime-tmux";
import {
  type Agent,
  type AgentLaunchConfig,
  type OrchestratorConfig,
  type PluginModule,
  type RuntimeHandle,
  type Session,
  type SessionManager,
  createSessionManager,
  createPluginRegistry,
  getProjectBaseDir,
  getSessionsDir,
} from "@composio/ao-core";
import { isTmuxAvailable, killSessionsByPrefix } from "./helpers/tmux.js";
import { sleep } from "./helpers/polling.js";

const tmuxOk = await isTmuxAvailable();
const SESSION_PREFIX = "ao-inttest-spawn-alive-";

/**
 * Stub agent plugin that stays alive. Returns a simple bash loop as the
 * launch command — this replaces Claude Code for testing the spawn pipeline.
 */
function createStubAgentPlugin(): PluginModule<Agent> {
  return {
    manifest: {
      name: "stub",
      slot: "agent" as const,
      description: "Stub agent for integration tests",
      version: "0.1.0",
    },
    create(): Agent {
      return {
        name: "stub",
        processName: "bash",

        getLaunchCommand(_config: AgentLaunchConfig): string {
          // Simple loop that stays alive — the key property being tested
          return "bash -c 'while true; do sleep 1; done'";
        },

        getEnvironment(): Record<string, string> {
          return {};
        },

        detectActivity(): "active" {
          return "active";
        },

        async getActivityState(): Promise<"active"> {
          return "active";
        },

        async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
          const runtime = tmuxPlugin.create();
          return runtime.isAlive(handle);
        },

        async getSessionInfo(): Promise<null> {
          return null;
        },
      } as Agent;
    },
  };
}

describe.skipIf(!tmuxOk)("sessionManager.spawn() pipeline (integration)", () => {
  let tmpDir: string;
  let configPath: string;
  let sm: SessionManager;
  let session: Session | null = null;
  let projectBaseDir: string;

  beforeAll(async () => {
    await killSessionsByPrefix(SESSION_PREFIX);

    const raw = await mkdtemp(join(tmpdir(), "ao-inttest-spawn-alive-"));
    tmpDir = await realpath(raw);

    // Write a real config file on disk (required by validateAndStoreOrigin)
    configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "# integration test config\n");

    // Build config object
    const config: OrchestratorConfig = {
      configPath,
      readyThresholdMs: 300_000,
      defaults: {
        runtime: "tmux",
        agent: "stub",
        workspace: "worktree", // Not registered → null → skip workspace creation
        notifiers: [],
      },
      projects: {
        test: {
          name: "test-project",
          repo: "test/test",
          path: tmpDir,
          defaultBranch: "main",
          sessionPrefix: SESSION_PREFIX.slice(0, -1), // Remove trailing dash
        },
      },
      notifiers: {},
      notificationRouting: {} as OrchestratorConfig["notificationRouting"],
      reactions: {},
    };

    // Build plugin registry with stub agent + real tmux
    const registry = createPluginRegistry();
    registry.register(tmuxPlugin);
    registry.register(createStubAgentPlugin());

    sm = createSessionManager({ config, registry });

    // Track the project base dir for cleanup
    projectBaseDir = getProjectBaseDir(configPath, tmpDir);
  }, 30_000);

  afterAll(async () => {
    // Kill spawned session via runtime
    if (session?.runtimeHandle) {
      try {
        const runtime = tmuxPlugin.create();
        await runtime.destroy(session.runtimeHandle);
      } catch {
        /* best-effort */
      }
    }

    // Clean up any leftover tmux sessions with our prefix
    await killSessionsByPrefix(SESSION_PREFIX);

    // Clean up metadata directory
    if (projectBaseDir && existsSync(projectBaseDir)) {
      await rm(projectBaseDir, { recursive: true, force: true }).catch(() => {});
    }

    // Clean up temp dir
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  it("spawn() creates a session with working status", async () => {
    session = await sm.spawn({ projectId: "test" });

    expect(session).toBeTruthy();
    expect(session.id).toMatch(/^ao-inttest-spawn-alive-\d+$/);
    expect(session.projectId).toBe("test");
    expect(session.status).toBe("working");
    expect(session.runtimeHandle).toBeTruthy();
    expect(session.runtimeHandle!.runtimeName).toBe("tmux");
  });

  it("metadata file exists with correct status", async () => {
    expect(session).toBeTruthy();

    const sessionsDir = getSessionsDir(configPath, tmpDir);
    const metaPath = join(sessionsDir, session!.id);
    expect(existsSync(metaPath)).toBe(true);

    const content = await readFile(metaPath, "utf-8");
    expect(content).toContain("status=working");
    expect(content).toContain(`project=test`);
  });

  it("process is alive immediately after spawn", async () => {
    expect(session?.runtimeHandle).toBeTruthy();
    const runtime = tmuxPlugin.create();
    expect(await runtime.isAlive(session!.runtimeHandle!)).toBe(true);
  });

  it("process stays alive after 3 seconds (not one-shot exit)", async () => {
    await sleep(3_000);
    expect(session?.runtimeHandle).toBeTruthy();
    const runtime = tmuxPlugin.create();
    expect(await runtime.isAlive(session!.runtimeHandle!)).toBe(true);
  });

  it("session can be killed via session manager", async () => {
    expect(session).toBeTruthy();
    await sm.kill(session!.id);

    const runtime = tmuxPlugin.create();
    expect(await runtime.isAlive(session!.runtimeHandle!)).toBe(false);

    // Clear session so afterAll doesn't try to destroy it again
    session = null;
  });
});
