import { execFile } from "node:child_process";
import { mkdtemp, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createPluginRegistry,
  createSessionManager,
  getOpenCodeClient,
  getSessionsDir,
  readMetadataRaw,
  type OrchestratorConfig,
  type ProjectConfig,
  type Session,
} from "@composio/ao-core";
import runtimeTmux from "@composio/ao-plugin-runtime-tmux";
import agentOpencode from "@composio/ao-plugin-agent-opencode";
import workspaceWorktree from "@composio/ao-plugin-workspace-worktree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTmuxAvailable } from "./helpers/tmux.js";
import { isOpencodeAvailable, listOpencodeModels, pickCheapModel } from "./helpers/opencode.js";
import { exportOpencodeSession } from "./helpers/opencode-export.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trimEnd();
}

async function isGitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

const tmuxOk = await isTmuxAvailable();
const opencodeOk = await isOpencodeAvailable();
const gitOk = await isGitAvailable();

describe.skipIf(!(tmuxOk && opencodeOk && gitOk))("agent-opencode-sdk parity (integration)", () => {
  let repoDir: string;
  let config: OrchestratorConfig;
  let project: ProjectConfig;
  let sessionManager: ReturnType<typeof createSessionManager>;
  let model: string | null = null;
  let spawnedSession: Session | null = null;
  let configPath: string;

  beforeAll(async () => {
    const rawRepo = await mkdtemp(join(tmpdir(), "ao-inttest-opencode-sdk-repo-"));
    repoDir = await realpath(rawRepo);

    await git(repoDir, "init", "-b", "main");
    await git(repoDir, "config", "user.email", "test@test.com");
    await git(repoDir, "config", "user.name", "Test");
    await execFileAsync("sh", ["-c", "echo hello > README.md"], { cwd: repoDir });
    await git(repoDir, "add", ".");
    await git(repoDir, "commit", "-m", "initial commit");
    await git(repoDir, "remote", "add", "origin", repoDir);
    await git(repoDir, "fetch", "origin");

    configPath = join(repoDir, "agent-orchestrator.inttest.yaml");
    await writeFile(configPath, "inttest: true\n", "utf-8");

    model = await pickCheapModel();

    config = {
      configPath,
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: {
        runtime: "tmux",
        agent: "opencode",
        workspace: "worktree",
        notifiers: [],
      },
      projects: {
        "opencode-project": {
          name: "OpenCode Inttest",
          repo: "test/opencode-inttest",
          path: repoDir,
          defaultBranch: "main",
          sessionPrefix: `opencode-sdk-inttest-${Date.now()}`,
          agent: "opencode",
          runtime: "tmux",
          workspace: "worktree",
          agentConfig: {
            permissions: "skip",
            ...(model ? { model } : {}),
          },
        },
      },
      notifiers: {},
      notificationRouting: {
        urgent: [],
        action: [],
        warning: [],
        info: [],
      },
      reactions: {},
    };

    project = config.projects["opencode-project"];

    const registry = createPluginRegistry();
    registry.register(runtimeTmux);
    registry.register(agentOpencode);
    registry.register(workspaceWorktree, { worktreeDir: join(tmpdir(), "ao-inttest-opencode-worktrees") });

    sessionManager = createSessionManager({ config, registry });
  }, 90_000);

  afterAll(async () => {
    if (spawnedSession) {
      try {
        await sessionManager.kill(spawnedSession.id);
      } catch {
        // best effort cleanup
      }
    }
    if (repoDir) {
      await rm(repoDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  it("T00: discovers cheap live model candidate", async () => {
    const models = await listOpencodeModels();
    expect(models.length).toBeGreaterThan(0);

    const model = await pickCheapModel();
    expect(model).toBeTruthy();
    expect(models).toContain(model as string);
  });

  it("T01: SDK bootstrap through sessionManager.spawn", async () => {
    spawnedSession = await sessionManager.spawn({
      projectId: "opencode-project",
    });

    expect(spawnedSession.id).toMatch(/^opencode-sdk-inttest-/);
    expect(spawnedSession.runtimeHandle).not.toBeNull();

    const sessionsDir = getSessionsDir(config.configPath, project.path);
    const metadata = readMetadataRaw(sessionsDir, spawnedSession.id);
    expect(metadata).not.toBeNull();
    expect(metadata?.opencodeMode).toBe("sdk");
    expect(metadata?.opencodeServerUrl).toMatch(/^http:\/\//);
    expect(metadata?.opencodeSessionId).toBeTruthy();
  }, 90_000);

  it("T02: server metadata and /global/health assertion", async () => {
    expect(spawnedSession).not.toBeNull();
    const sessionsDir = getSessionsDir(config.configPath, project.path);
    const metadata = readMetadataRaw(sessionsDir, spawnedSession!.id);
    expect(metadata).not.toBeNull();
    expect(metadata?.opencodeServerUrl).toBeTruthy();
    expect(Number(metadata?.opencodeServerPid)).toBeGreaterThan(0);
    expect(metadata?.opencodeSessionId).toBeTruthy();

    const healthResp = await fetch(`${metadata!.opencodeServerUrl}/global/health`);
    expect(healthResp.ok).toBe(true);
    const health = (await healthResp.json()) as { healthy?: boolean; version?: string };
    expect(health.healthy).toBe(true);
    expect(typeof health.version).toBe("string");
  }, 30_000);

  it("T03: OpenCode session continuity via export/session.get", async () => {
    expect(spawnedSession).not.toBeNull();
    const sessionsDir = getSessionsDir(config.configPath, project.path);
    const metadata = readMetadataRaw(sessionsDir, spawnedSession!.id);
    expect(metadata?.opencodeServerUrl).toBeTruthy();
    expect(metadata?.opencodeSessionId).toBeTruthy();

    const client = getOpenCodeClient(metadata!.opencodeServerUrl!);
    const session = await client.session.get({ path: { id: metadata!.opencodeSessionId! } });
    const sessionData = session.data as { id?: string };
    expect(sessionData.id).toBe(metadata!.opencodeSessionId!);

    const exported = await exportOpencodeSession(metadata!.opencodeSessionId!, project.path);
    expect(exported).toContain(metadata!.opencodeSessionId!);
  }, 60_000);
  it.todo("T04: send() routes via SDK and appends assistant turn");
  it.todo("T05: activity state is non-null and session-specific");
  it.todo("T06: session info isolation across two sessions same workspace");
  it.todo("T07: restore keeps same OpenCode session timeline");
  it.todo("T08: kill aborts/deletes OpenCode session and server pid");
  it.todo("T09: web terminal attach mode uses opencode -s --attach");
  it.todo("T10: non-opencode terminal path remains tmux attach");
  it.todo("T11: /api/sessions/[id]/message delegates via session-manager");
  it.todo("T12: full lifecycle smoke with metadata invariants");
});
