import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  loadGlobalConfig,
  repairWrappedLocalProjectConfig,
  registerProjectInGlobalConfig,
  relinkProjectInGlobalConfig,
  resolveProjectIdentity,
  saveGlobalConfig,
  StorageKeyCollisionError,
  type GlobalConfig,
} from "../global-config.js";
import { getProjectBaseDir, getSessionsDir } from "../paths.js";
import { deriveStorageKey } from "../storage-key.js";

function makeGlobalConfig(projects: GlobalConfig["projects"] = {}): GlobalConfig {
  return {
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects,
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  };
}

describe("global-config storage identity", () => {
  let tempRoot: string;
  let configPath: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempRoot = join(tmpdir(), `ao-global-config-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempRoot, { recursive: true });
    configPath = join(tempRoot, "config.yaml");
    originalHome = process.env["HOME"];
    process.env["HOME"] = tempRoot;
  });

  afterEach(() => {
    process.env["HOME"] = originalHome;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function createRepo(repoName: string, originUrl?: string): string {
    const repoPath = join(tempRoot, repoName);
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    const remoteBlock = originUrl ? `\n[remote "origin"]\n  url = ${originUrl}\n` : "\n";
    writeFileSync(join(repoPath, ".git", "config"), `[core]\n  repositoryformatversion = 0${remoteBlock}`);
    return repoPath;
  }

  function legacyStorageKey(projectPath: string): string {
    return createHash("sha256").update(resolve(projectPath)).digest("hex").slice(0, 12);
  }

  it("registers identity fields without persisting behavior fields", () => {
    const repoPath = createRepo("demo", "git@github.com:OpenAI/demo.git");

    registerProjectInGlobalConfig("demo", "Demo", repoPath, { agent: "codex", runtime: "tmux" }, configPath);

    const config = loadGlobalConfig(configPath);
    const expectedStorageKey = deriveStorageKey({
      originUrl: "git@github.com:OpenAI/demo.git",
      gitRoot: repoPath,
      projectPath: repoPath,
    });

    expect(config?.projects["demo"]).toMatchObject({
      projectId: "demo",
      displayName: "Demo",
      path: repoPath,
      storageKey: expectedStorageKey,
      defaultBranch: "main",
      sessionPrefix: "demo",
      source: "ao-project-add",
      repo: {
        owner: "OpenAI",
        name: "demo",
        platform: "github",
        originUrl: "https://github.com/OpenAI/demo",
      },
    });
    expect(config?.projects["demo"]).not.toHaveProperty("agent");
    expect(config?.projects["demo"]).not.toHaveProperty("runtime");
  });

  it("detects storage-key collisions for different project ids", () => {
    const repoPath = createRepo("demo", "https://github.com/OpenAI/demo.git");
    const clonePath = createRepo("demo-clone", "git@github.com:OpenAI/demo.git");

    registerProjectInGlobalConfig("demo", "Demo", repoPath, undefined, configPath);

    expect(() =>
      registerProjectInGlobalConfig("demo-clone", "Demo Clone", clonePath, undefined, configPath),
    ).toThrow(StorageKeyCollisionError);
  });

  it("allows an explicit second registration when collision is confirmed", () => {
    const repoPath = createRepo("demo", "https://github.com/OpenAI/demo.git");
    const clonePath = createRepo("demo-clone", "git@github.com:OpenAI/demo.git");

    registerProjectInGlobalConfig("demo", "Demo", repoPath, undefined, configPath);
    registerProjectInGlobalConfig(
      "demo-clone",
      "Demo Clone",
      clonePath,
      undefined,
      { allowStorageKeyReuse: true },
      configPath,
    );

    const config = loadGlobalConfig(configPath);
    expect(config?.projects["demo-clone"]?.storageKey).toBe(config?.projects["demo"]?.storageKey);
  });

  it("relinks storage atomically and requires force when sessions exist", () => {
    const repoPath = createRepo("demo", "https://github.com/OpenAI/demo.git");
    registerProjectInGlobalConfig("demo", "Demo", repoPath, undefined, configPath);

    const config = loadGlobalConfig(configPath)!;
    const oldStorageKey = config.projects["demo"]!.storageKey!;
    const oldBaseDir = getProjectBaseDir(oldStorageKey);
    mkdirSync(getSessionsDir(oldStorageKey), { recursive: true });
    writeFileSync(join(getSessionsDir(oldStorageKey), "demo-1.json"), "{}");

    expect(() =>
      relinkProjectInGlobalConfig("demo", { url: "https://gitlab.com/OpenAI/demo.git" }, configPath),
    ).toThrow(/--force/);

    const result = relinkProjectInGlobalConfig(
      "demo",
      { url: "https://gitlab.com/OpenAI/demo.git", force: true },
      configPath,
    );

    expect(result.oldStorageKey).toBe(oldStorageKey);
    expect(result.storageKey).not.toBe(oldStorageKey);
    expect(existsSync(oldBaseDir)).toBe(false);
    expect(existsSync(getProjectBaseDir(result.storageKey))).toBe(true);
    expect(loadGlobalConfig(configPath)?.projects["demo"]).toMatchObject({
      storageKey: result.storageKey,
      repo: {
        owner: "OpenAI",
        name: "demo",
        platform: "gitlab",
        originUrl: "https://gitlab.com/OpenAI/demo",
      },
    });
  });

  it("migrates legacy entries by deriving a content-addressed key and moving the old storage dir", () => {
    const repoPath = createRepo("legacy", "git@github.com:OpenAI/legacy.git");
    const oldStorageKey = legacyStorageKey(repoPath);
    const oldBaseDir = join(tempRoot, ".agent-orchestrator", `${oldStorageKey}-legacy`);
    mkdirSync(join(oldBaseDir, "sessions"), { recursive: true });
    writeFileSync(join(oldBaseDir, "sessions", "legacy-1.json"), "{}");

    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      saveGlobalConfig(
        makeGlobalConfig({
          legacy: {
            displayName: "Legacy",
            path: repoPath,
          },
        }),
        configPath,
      );

      const resolved = resolveProjectIdentity("legacy", loadGlobalConfig(configPath)!, configPath);
      const expectedStorageKey = deriveStorageKey({
        originUrl: "git@github.com:OpenAI/legacy.git",
        gitRoot: repoPath,
        projectPath: repoPath,
      });

      expect(resolved?.storageKey).toBe(expectedStorageKey);
      expect(loadGlobalConfig(configPath)?.projects["legacy"]).toMatchObject({
        storageKey: expectedStorageKey,
        repo: {
          owner: "OpenAI",
          name: "legacy",
          platform: "github",
          originUrl: "https://github.com/OpenAI/legacy",
        },
      });
      expect(existsSync(oldBaseDir)).toBe(false);
      expect(existsSync(getProjectBaseDir(expectedStorageKey))).toBe(true);
      expect(consoleInfo).toHaveBeenCalledWith(
        expect.stringContaining('migrated storage identity for "legacy"'),
      );
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it("strips stale shadow fields from legacy entries and rewrites the config", () => {
    const repoPath = createRepo("legacy", "https://github.com/OpenAI/demo.git");
    writeFileSync(
      configPath,
      [
        "port: 3000",
        "readyThresholdMs: 300000",
        "defaults:",
        "  runtime: tmux",
        "  agent: claude-code",
        "  workspace: worktree",
        "  notifiers: []",
        "projects:",
        "  legacy:",
        `    path: ${repoPath}`,
        "    name: Legacy",
        "    agent: codex",
        "    runtime: docker",
        "    _shadowSyncedAt: 123",
        "notifiers: {}",
        "notificationRouting: {}",
        "reactions: {}",
        "",
      ].join("\n"),
    );

    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const config = loadGlobalConfig(configPath);
      expect(config?.projects["legacy"]).toMatchObject({
        projectId: "legacy",
        displayName: "Legacy",
        path: repoPath,
      });
      expect(config?.projects["legacy"]).not.toHaveProperty("agent");
      expect(config?.projects["legacy"]).not.toHaveProperty("runtime");

      const rewritten = parseYaml(readFileSync(configPath, "utf-8")) as {
        projects: Record<string, Record<string, unknown>>;
      };
      expect(rewritten.projects.legacy).not.toHaveProperty("agent");
      expect(rewritten.projects.legacy).not.toHaveProperty("runtime");
      expect(rewritten.projects.legacy).not.toHaveProperty("_shadowSyncedAt");
      expect(consoleInfo).toHaveBeenCalledWith(
        "[ao] stripped 3 legacy project registry fields from 1 project: legacy (3)",
      );
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it("migrates legacy string repo fields into repo identity objects on load", () => {
    const repoPath = createRepo("legacy-repo", "https://github.com/OpenAI/demo.git");
    writeFileSync(
      configPath,
      [
        "port: 3000",
        "readyThresholdMs: 300000",
        "defaults:",
        "  runtime: tmux",
        "  agent: claude-code",
        "  workspace: worktree",
        "  notifiers: []",
        "projects:",
        "  legacy:",
        `    path: ${repoPath}`,
        "    repo: OpenAI/demo",
        "notifiers: {}",
        "notificationRouting: {}",
        "reactions: {}",
        "",
      ].join("\n"),
    );

    const config = loadGlobalConfig(configPath);
    expect(config?.projects["legacy"]?.repo).toEqual({
      owner: "OpenAI",
      name: "demo",
      platform: "github",
      originUrl: "https://github.com/OpenAI/demo",
    });

    const rewritten = parseYaml(readFileSync(configPath, "utf-8")) as {
      projects: Record<string, Record<string, unknown>>;
    };
    expect(rewritten.projects.legacy.repo).toEqual({
      owner: "OpenAI",
      name: "demo",
      platform: "github",
      originUrl: "https://github.com/OpenAI/demo",
    });
  });

  it("repairs a wrapped local project config into flat behavior-only config", () => {
    const repoPath = createRepo("wrapped-local", "https://github.com/OpenAI/demo.git");
    writeFileSync(
      join(repoPath, "agent-orchestrator.yaml"),
      [
        "projects:",
        "  wrapped-local:",
        `    path: ${repoPath}`,
        "    name: Wrapped Local",
        "    agent: codex",
        "    runtime: tmux",
        "",
      ].join("\n"),
    );

    repairWrappedLocalProjectConfig("wrapped-local", repoPath);

    const repaired = parseYaml(readFileSync(join(repoPath, "agent-orchestrator.yaml"), "utf-8"));
    expect(repaired).toEqual({
      agent: "codex",
      runtime: "tmux",
    });
  });

  it("registers a project successfully even when the existing config needs shadow-field cleanup", () => {
    const legacyRepoPath = createRepo("legacy", "https://github.com/OpenAI/legacy.git");
    const freshRepoPath = createRepo("fresh", "https://github.com/OpenAI/fresh.git");

    writeFileSync(
      configPath,
      [
        "port: 3000",
        "readyThresholdMs: 300000",
        "defaults:",
        "  runtime: tmux",
        "  agent: claude-code",
        "  workspace: worktree",
        "  notifiers: []",
        "projects:",
        "  legacy:",
        `    path: ${legacyRepoPath}`,
        "    name: Legacy",
        "    agent: codex",
        "    runtime: docker",
        "notifiers: {}",
        "notificationRouting: {}",
        "reactions: {}",
        "",
      ].join("\n"),
    );

    registerProjectInGlobalConfig("fresh", "Fresh", freshRepoPath, undefined, configPath);

    const config = loadGlobalConfig(configPath);
    expect(config?.projects["fresh"]).toMatchObject({
      projectId: "fresh",
      displayName: "Fresh",
      path: freshRepoPath,
    });
    expect(config?.projects["legacy"]).not.toHaveProperty("agent");
    expect(config?.projects["legacy"]).not.toHaveProperty("runtime");
  });

  it("uses the synthetic local storage key when no origin can be read", () => {
    const repoPath = createRepo("local-only");
    saveGlobalConfig(
      makeGlobalConfig({
        local: {
          displayName: "Local",
          path: repoPath,
        },
      }),
      configPath,
    );

    const resolved = resolveProjectIdentity("local", loadGlobalConfig(configPath)!, configPath);
    const expectedStorageKey = deriveStorageKey({
      originUrl: null,
      gitRoot: repoPath,
      projectPath: repoPath,
    });

    expect(resolved?.storageKey).toBe(expectedStorageKey);
    expect(loadGlobalConfig(configPath)?.projects["local"]?.repo).toBeUndefined();
  });
});
