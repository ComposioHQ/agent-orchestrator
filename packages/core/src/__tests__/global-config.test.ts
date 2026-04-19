import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadGlobalConfig,
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

  it("preserves storage identity fields during shadow sync-friendly registration", () => {
    const repoPath = createRepo("demo", "git@github.com:OpenAI/demo.git");

    registerProjectInGlobalConfig("demo", "Demo", repoPath, { agent: "codex" }, configPath);

    const config = loadGlobalConfig(configPath);
    const expectedStorageKey = deriveStorageKey({
      originUrl: "git@github.com:OpenAI/demo.git",
      gitRoot: repoPath,
      projectPath: repoPath,
    });

    expect(config?.projects["demo"]).toMatchObject({
      name: "Demo",
      path: repoPath,
      storageKey: expectedStorageKey,
      originUrl: "https://github.com/OpenAI/demo",
      agent: "codex",
    });
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
      originUrl: "https://gitlab.com/OpenAI/demo",
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
            name: "Legacy",
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
        originUrl: "https://github.com/OpenAI/legacy",
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

  it("uses the synthetic local url during migration when no origin can be read", () => {
    const repoPath = createRepo("local-only");
    saveGlobalConfig(
      makeGlobalConfig({
        local: {
          name: "Local",
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
    expect(loadGlobalConfig(configPath)?.projects["local"]?.originUrl).toBe(`local://${repoPath}`);
  });
});
