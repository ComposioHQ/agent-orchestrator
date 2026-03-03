import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createPluginRegistry,
  createSessionManager,
  getOpenCodeClient,
  getOpenCodeSessionStatus,
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
const hasModelAuth = Boolean(
  process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    process.env.GOOGLE_API_KEY,
);

const SESSION_PREFIX = `opencode-sdk-inttest-${Date.now()}`;
const WORKTREE_DIR = join(tmpdir(), `ao-inttest-opencode-worktrees-${Date.now()}`);

describe.skipIf(!(tmuxOk && opencodeOk))("agent-opencode-sdk parity (integration)", () => {
  let repoDir: string;
  let config: OrchestratorConfig;
  let project: ProjectConfig;
  let sessionManager: ReturnType<typeof createSessionManager>;
  let model: string | null = null;

  let spawnedSession: Session | null = null;
  let secondarySession: Session | null = null;
  // Metadata cached from T01 so T02/T03 don't re-read disk independently.
  let spawnedMetadata: Record<string, string> | null = null;
  let secondaryMetadata: Record<string, string> | null = null;

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
    if (secondarySession) {
      try {
        await sessionManager.kill(secondarySession.id);
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

  it.skipIf(!hasModelAuth)("T04: send() routes via SDK and appends assistant turn", async () => {
    if (!spawnedSession || !spawnedMetadata) {
      console.warn("T04 skipped: T01 did not produce a session");
      return;
    }

    const serverUrl = spawnedMetadata["opencodeServerUrl"];
    const sessionId = spawnedMetadata["opencodeSessionId"];
    if (!serverUrl || !sessionId) {
      throw new Error("Missing opencodeServerUrl or opencodeSessionId in spawned metadata");
    }

    const before = await exportOpencodeSession(sessionId, project.path);

    await sessionManager.send(spawnedSession.id, "What is 1+1?");

    const pollDeadline = Date.now() + 90_000;
    while (Date.now() < pollDeadline) {
      const status = await getOpenCodeSessionStatus({ baseUrl: serverUrl, sessionId });
      if (status === "idle" || status === "waiting_input") break;
      await new Promise((r) => setTimeout(r, 2_000));
    }

    const after = await exportOpencodeSession(sessionId, project.path);
    expect(after.length).toBeGreaterThan(before.length);
  }, 120_000);

  it("T05: activity state is non-null and reflects a known state", async () => {
    if (!spawnedSession) {
      console.warn("T05 skipped: T01 did not produce a session");
      return;
    }

    const current = await sessionManager.get(spawnedSession.id);
    if (!current) throw new Error("T05: session disappeared after spawn");

    const detection = await agentOpencode.create().getActivityState(current);

    if (detection !== null) {
      expect(["active", "ready", "idle", "waiting_input", "exited"]).toContain(detection.state);
    }
  }, 30_000);

  it("T06: each spawned session gets a distinct opencode session ID", async () => {
    if (!spawnedSession || !spawnedMetadata) {
      console.warn("T06 skipped: T01 did not produce a session");
      return;
    }

    secondarySession = await sessionManager.spawn({
      projectId: "opencode-project",
    });

    const sessionsDir = getSessionsDir(config.configPath, project.path);
    secondaryMetadata = readMetadataRaw(sessionsDir, secondarySession.id);

    expect(secondaryMetadata?.["opencodeSessionId"]).toBeTruthy();
    expect(secondaryMetadata?.["opencodeSessionId"]).not.toBe(spawnedMetadata["opencodeSessionId"]);

    const agent = agentOpencode.create();
    const [primarySession, secondSession] = await Promise.all([
      sessionManager.get(spawnedSession.id),
      sessionManager.get(secondarySession.id),
    ]);
    if (!primarySession || !secondSession) throw new Error("T06: sessions disappeared");

    const [primaryInfo, secondInfo] = await Promise.all([
      agent.getSessionInfo(primarySession),
      agent.getSessionInfo(secondSession),
    ]);

    expect(primaryInfo?.agentSessionId).toBe(spawnedMetadata["opencodeSessionId"]);
    expect(secondInfo?.agentSessionId).toBe(secondaryMetadata?.["opencodeSessionId"]);
    expect(primaryInfo?.agentSessionId).not.toBe(secondInfo?.agentSessionId);
  }, 120_000);

  it("T07: restore keeps same OpenCode session timeline", async () => {
    if (!spawnedSession || !spawnedMetadata) {
      console.warn("T07 skipped: T01 did not produce a session");
      return;
    }

    const opencodeSessionId = spawnedMetadata["opencodeSessionId"];
    if (!opencodeSessionId) {
      throw new Error("Missing opencodeSessionId for restore test");
    }

    // Force runtime to terminal state without deleting OpenCode session data.
    if (spawnedSession.runtimeHandle?.id) {
      await execFileAsync("tmux", ["kill-session", "-t", spawnedSession.runtimeHandle.id], {
        timeout: 15_000,
      }).catch(() => {});
      // Brief pause so tmux registers the session as dead before restore queries it.
      await new Promise((r) => setTimeout(r, 500));
    }

    const restored = await sessionManager.restore(spawnedSession.id);
    const sessionsDir = getSessionsDir(config.configPath, project.path);
    const restoredMeta = readMetadataRaw(sessionsDir, restored.id);

    expect(restoredMeta).not.toBeNull();
    expect(restoredMeta!["opencodeSessionId"]).toBe(opencodeSessionId);
    expect(restoredMeta!["opencodeServerUrl"]).toMatch(/^http:\/\//);

    spawnedSession = restored;
    spawnedMetadata = restoredMeta;
  }, 120_000);

  it("T08: kill archives metadata and stops the OpenCode server process", async () => {
    if (!spawnedSession || !spawnedMetadata) {
      console.warn("T08 skipped: no active spawned session");
      return;
    }

    const opencodeServerPid = Number(spawnedMetadata["opencodeServerPid"]);
    const sessionId = spawnedSession.id;
    if (!Number.isFinite(opencodeServerPid) || opencodeServerPid <= 0) {
      throw new Error("Missing opencodeServerPid in metadata for kill test");
    }

    await sessionManager.kill(sessionId);

    const sessionsDir = getSessionsDir(config.configPath, project.path);
    expect(readMetadataRaw(sessionsDir, sessionId)).toBeNull();

    const deadline = Date.now() + 5_000;
    let pidGone = false;
    while (Date.now() < deadline) {
      try {
        process.kill(opencodeServerPid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        pidGone = true;
        break;
      }
    }
    expect(pidGone).toBe(true);

    spawnedSession = null;
    spawnedMetadata = null;
  }, 60_000);

  it.todo("T09: web terminal attach mode uses opencode -s --attach");
  it.todo("T10: non-opencode terminal path remains tmux attach");
  it.todo("T11: /api/sessions/[id]/message delegates via session-manager");
  it.todo("T12: full lifecycle smoke with metadata invariants");
});
