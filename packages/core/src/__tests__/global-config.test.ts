import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEffectiveProjectConfig,
  getGlobalConfigPath,
  isOldConfigFormat,
  isProjectShadowStale,
  loadGlobalConfig,
  loadLocalProjectConfig,
  migrateToGlobalConfig,
  registerProjectInGlobalConfig,
  saveGlobalConfig,
  syncProjectShadow,
} from "../global-config.js";

describe("global-config", () => {
  let tempRoot: string;
  let previousHome: string | undefined;
  let previousGlobalConfig: string | undefined;
  let globalConfigPath: string;

  beforeEach(() => {
    tempRoot = join(tmpdir(), `ao-global-config-${Date.now()}-${Math.random()}`);
    mkdirSync(tempRoot, { recursive: true });
    previousHome = process.env.HOME;
    previousGlobalConfig = process.env.AO_GLOBAL_CONFIG;
    process.env.HOME = tempRoot;
    globalConfigPath = join(tempRoot, "custom-global.yaml");
    process.env.AO_GLOBAL_CONFIG = globalConfigPath;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousGlobalConfig === undefined) {
      delete process.env.AO_GLOBAL_CONFIG;
    } else {
      process.env.AO_GLOBAL_CONFIG = previousGlobalConfig;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("prefers AO_GLOBAL_CONFIG when resolving the global config path", () => {
    expect(getGlobalConfigPath()).toBe(globalConfigPath);
  });

  it("saves and loads global config while expanding tilde-prefixed project paths", () => {
    saveGlobalConfig(
      {
        port: 3001,
        readyThresholdMs: 123,
        defaults: {
          runtime: "tmux",
          agent: "claude-code",
          workspace: "worktree",
          notifiers: ["desktop"],
        },
        projects: {
          demo: {
            name: "Demo",
            path: "~/repos/demo",
            repo: "acme/demo",
          },
        },
        notifiers: {},
        notificationRouting: { urgent: [], action: [], warning: [], info: [] },
        reactions: {},
      },
      globalConfigPath,
    );

    const loaded = loadGlobalConfig(globalConfigPath);
    expect(loaded?.port).toBe(3001);
    expect(loaded?.projects["demo"]?.path).toBe(join(tempRoot, "repos", "demo"));
  });

  it("loads flat local project configs and rejects wrapped old-format configs", () => {
    const flatProject = join(tempRoot, "flat-project");
    mkdirSync(flatProject, { recursive: true });
    writeFileSync(
      join(flatProject, "agent-orchestrator.yaml"),
      "repo: acme/demo\nruntime: tmux\nagent: claude-code\n",
    );

    const oldProject = join(tempRoot, "old-project");
    mkdirSync(oldProject, { recursive: true });
    writeFileSync(
      join(oldProject, "agent-orchestrator.yaml"),
      "projects:\n  demo:\n    path: /tmp/demo\n    repo: acme/demo\n",
    );

    const invalidProject = join(tempRoot, "invalid-project");
    mkdirSync(invalidProject, { recursive: true });
    writeFileSync(join(invalidProject, "agent-orchestrator.yaml"), "{not yaml");

    expect(loadLocalProjectConfig(flatProject)).toMatchObject({
      repo: "acme/demo",
      runtime: "tmux",
    });
    expect(loadLocalProjectConfig(oldProject)).toBeNull();
    expect(loadLocalProjectConfig(invalidProject)).toBeNull();
  });

  it("syncs shadow fields while preserving identity and excluding secret/internal fields", () => {
    saveGlobalConfig(
      {
        port: 3000,
        readyThresholdMs: 300_000,
        defaults: {
          runtime: "tmux",
          agent: "claude-code",
          workspace: "worktree",
          notifiers: ["desktop"],
        },
        projects: {
          demo: {
            name: "Demo Name",
            path: "/tmp/demo",
            existingBehavior: "keep-me",
          },
        },
        notifiers: {},
        notificationRouting: { urgent: [], action: [], warning: [], info: [] },
        reactions: {},
      },
      globalConfigPath,
    );

    syncProjectShadow(
      "demo",
      {
        repo: "acme/demo",
        agent: "codex",
        apiToken: "secret",
        _internalFlag: true,
      },
      globalConfigPath,
    );

    const loaded = loadGlobalConfig(globalConfigPath);
    expect(loaded?.projects["demo"]).toMatchObject({
      name: "Demo Name",
      path: "/tmp/demo",
      repo: "acme/demo",
      agent: "codex",
    });
    expect(loaded?.projects["demo"]).not.toHaveProperty("apiToken");
    expect(loaded?.projects["demo"]).not.toHaveProperty("_internalFlag");
    expect(typeof loaded?.projects["demo"]?._shadowSyncedAt).toBe("number");
  });

  it("registers a project and immediately syncs local shadow fields when provided", () => {
    registerProjectInGlobalConfig(
      "demo",
      "Demo",
      "/tmp/demo",
      { repo: "acme/demo", runtime: "tmux" },
      globalConfigPath,
    );

    const loaded = loadGlobalConfig(globalConfigPath);
    expect(loaded?.projects["demo"]).toMatchObject({
      name: "Demo",
      path: "/tmp/demo",
      repo: "acme/demo",
      runtime: "tmux",
    });
  });

  it("builds effective project config using local behavior when a flat local config exists", () => {
    const repoPath = join(tempRoot, "repos", "demo");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(
      join(repoPath, "agent-orchestrator.yaml"),
      "repo: acme/local-demo\nagent: codex\nworkspace: worktree\n",
    );

    const globalConfig = {
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: ["desktop"],
      },
      projects: {
        demo: {
          name: "Demo",
          path: repoPath,
          repo: "acme/shadow-demo",
          runtime: "process",
          _shadowSyncedAt: 100,
        },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    };

    expect(buildEffectiveProjectConfig("demo", globalConfig)).toMatchObject({
      name: "Demo",
      path: repoPath,
      repo: "acme/local-demo",
      agent: "codex",
      runtime: "process",
      workspace: "worktree",
    });
  });

  it("falls back to shadow behavior when local config is absent and detects stale shadow", () => {
    const repoPath = join(tempRoot, "repos", "shadow-demo");
    mkdirSync(repoPath, { recursive: true });

    const globalConfig = {
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: ["desktop"],
      },
      projects: {
        demo: {
          path: repoPath,
          repo: "acme/demo",
          runtime: "tmux",
          _shadowSyncedAt: Math.floor(Date.now() / 1000),
        },
        neverSynced: {
          path: repoPath,
        },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    };

    expect(buildEffectiveProjectConfig("demo", globalConfig)).toMatchObject({
      name: "demo",
      path: repoPath,
      repo: "acme/demo",
      runtime: "tmux",
    });
    expect(buildEffectiveProjectConfig("missing", globalConfig)).toBeNull();
    expect(isProjectShadowStale("missing", globalConfig)).toBe(false);
    expect(isProjectShadowStale("neverSynced", globalConfig)).toBe(true);

    const localConfigPath = join(repoPath, "agent-orchestrator.yaml");
    writeFileSync(localConfigPath, "repo: acme/demo\n");
    const staleTimestamp = Math.floor(statSync(localConfigPath).mtimeMs / 1000) - 1;
    expect(
      isProjectShadowStale("demo", {
        ...globalConfig,
        projects: {
          ...globalConfig.projects,
          demo: { ...globalConfig.projects.demo, _shadowSyncedAt: staleTimestamp },
        },
      }),
    ).toBe(true);
  });

  it("detects old-format configs and migrates them to global + local hybrid config", () => {
    const repoPath = join(tempRoot, "repos", "demo");
    mkdirSync(repoPath, { recursive: true });
    const oldConfigPath = join(repoPath, "agent-orchestrator.yaml");
    writeFileSync(
      oldConfigPath,
      [
        "port: 4100",
        "defaults:",
        "  runtime: tmux",
        "  agent: claude-code",
        "  workspace: worktree",
        "  notifiers: [desktop]",
        "projects:",
        "  demo:",
        `    path: ${repoPath}`,
        "    name: Demo App",
        "    sessionPrefix: demo",
        "    repo: acme/demo",
        "    runtime: process",
      ].join("\n"),
    );

    expect(isOldConfigFormat({ projects: { demo: { path: repoPath } } })).toBe(true);
    expect(isOldConfigFormat({ projects: { demo: { repo: "acme/demo" } } })).toBe(false);

    const migratedPath = migrateToGlobalConfig(oldConfigPath, globalConfigPath);
    expect(migratedPath).toBe(globalConfigPath);
    expect(existsSync(globalConfigPath)).toBe(true);

    const migratedGlobal = loadGlobalConfig(globalConfigPath);
    expect(migratedGlobal?.port).toBe(4100);
    expect(migratedGlobal?.projects["demo"]).toMatchObject({
      name: "Demo App",
      path: repoPath,
      repo: "acme/demo",
      runtime: "process",
    });

    const rewrittenLocal = readFileSync(oldConfigPath, "utf-8");
    expect(rewrittenLocal).toContain("repo: acme/demo");
    expect(rewrittenLocal).not.toContain("projects:");
    expect(rewrittenLocal).not.toContain("name:");
    expect(rewrittenLocal).not.toContain("path:");
  });
});
