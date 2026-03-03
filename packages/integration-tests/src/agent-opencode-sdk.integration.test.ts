import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import {
  isOpencodeAvailable,
  listOpencodeModels,
  pickCheapModel,
  exportOpencodeSession,
} from "./helpers/opencode.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 30_000 });
  return stdout.trimEnd();
}

const tmuxOk = await isTmuxAvailable();
const opencodeOk = await isOpencodeAvailable();

const SESSION_PREFIX = `opencode-sdk-inttest-${Date.now()}`;
const WORKTREE_DIR = join(tmpdir(), `ao-inttest-opencode-worktrees-${Date.now()}`);

describe.skipIf(!(tmuxOk && opencodeOk))("agent-opencode-sdk parity (integration)", () => {
  let repoDir: string;
  let config: OrchestratorConfig;
  let project: ProjectConfig;
  let sessionManager: ReturnType<typeof createSessionManager>;
  let model: string | null = null;

  let spawnedSession: Session | null = null;
  // Metadata cached from T01 so T02/T03 don't re-read disk independently.
  let spawnedMetadata: Record<string, string> | null = null;

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "ao-inttest-opencode-sdk-repo-"));

    await git(repoDir, "init", "-b", "main");
    await git(repoDir, "config", "user.email", "test@test.com");
    await git(repoDir, "config", "user.name", "Test");
    await execFileAsync("sh", ["-c", "echo hello > README.md"], { cwd: repoDir });
    await git(repoDir, "add", ".");
    await git(repoDir, "commit", "-m", "initial commit");
    // Use the repo itself as its own remote so the worktree plugin can fetch.
    await git(repoDir, "remote", "add", "origin", repoDir);
    await git(repoDir, "fetch", "origin");

    model = await pickCheapModel();

    const configPath = join(repoDir, "agent-orchestrator.inttest.yaml");
    // realpathSync(configPath) inside paths.ts requires the file to exist.
    await writeFile(configPath, "", "utf-8");

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
          sessionPrefix: SESSION_PREFIX,
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
    registry.register(workspaceWorktree, { worktreeDir: WORKTREE_DIR });

    sessionManager = createSessionManager({ config, registry });
  }, 90_000);

  afterAll(async () => {
    if (spawnedSession) {
      try {
        await sessionManager.kill(spawnedSession.id);
      } catch {
        // best-effort; process may already be gone
      }
    }
    await Promise.allSettled([
      repoDir ? rm(repoDir, { recursive: true, force: true }) : Promise.resolve(),
      rm(WORKTREE_DIR, { recursive: true, force: true }),
    ]);
  }, 60_000);

  it("T00: discovers cheap live model candidate", async () => {
    const models = await listOpencodeModels();
    expect(models.length).toBeGreaterThan(0);

    const picked = await pickCheapModel();
    expect(picked).toBeTruthy();
    expect(models).toContain(picked as string);
  });

  it("T01: SDK bootstrap through sessionManager.spawn", async () => {
    spawnedSession = await sessionManager.spawn({
      projectId: "opencode-project",
    });

    expect(spawnedSession.id).toMatch(new RegExp(`^${SESSION_PREFIX}-\\d+$`));
    expect(spawnedSession.runtimeHandle).not.toBeNull();

    const sessionsDir = getSessionsDir(config.configPath, project.path);
    spawnedMetadata = readMetadataRaw(sessionsDir, spawnedSession.id);

    expect(spawnedMetadata).not.toBeNull();
    expect(spawnedMetadata?.["opencodeMode"]).toBe("sdk");
    expect(spawnedMetadata?.["opencodeServerUrl"]).toMatch(/^http:\/\//);
    expect(spawnedMetadata?.["opencodeSessionId"]).toBeTruthy();
  }, 90_000);

  it("T02: server metadata and /global/health assertion", async () => {
    if (!spawnedSession || !spawnedMetadata) {
      console.warn("T02 skipped: T01 did not produce a session");
      return;
    }

    expect(Number(spawnedMetadata["opencodeServerPid"])).toBeGreaterThan(0);

    const healthResp = await fetch(`${spawnedMetadata["opencodeServerUrl"]}/global/health`);
    expect(healthResp.ok).toBe(true);
    const health = (await healthResp.json()) as { healthy?: boolean; version?: string };
    expect(health.healthy).toBe(true);
    expect(typeof health.version).toBe("string");
  }, 30_000);

  it("T03: OpenCode session continuity via export/session.get", async () => {
    if (!spawnedSession || !spawnedMetadata) {
      console.warn("T03 skipped: T01 did not produce a session");
      return;
    }

    const serverUrl = spawnedMetadata["opencodeServerUrl"];
    const opencodeSessionId = spawnedMetadata["opencodeSessionId"];
    expect(serverUrl).toBeTruthy();
    expect(opencodeSessionId).toBeTruthy();

    const client = getOpenCodeClient(serverUrl!);
    const session = await client.session.get({ path: { id: opencodeSessionId! } });
    const sessionData = session.data as { id?: string };
    expect(sessionData.id).toBe(opencodeSessionId);

    const exported = await exportOpencodeSession(opencodeSessionId!, project.path);
    expect(exported).toContain(opencodeSessionId);
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
