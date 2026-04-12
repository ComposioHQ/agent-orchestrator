import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getGlobalConfigPath,
  loadGlobalConfig,
  saveGlobalConfig,
  syncProjectShadow,
  registerProjectInGlobalConfig,
  buildEffectiveProjectConfig,
  loadLocalProjectConfig,
  isProjectShadowStale,
  isOldConfigFormat,
  migrateToGlobalConfig,
  type GlobalConfig,
} from "../global-config.js";

describe("global-config", () => {
  let tempRoot: string;
  let configPath: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "global-config-test-"));
    configPath = join(tempRoot, "global-config.yaml");
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("preserves sessionPrefix when syncing a flat local project shadow", () => {
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
            name: "Demo",
            path: "/tmp/demo",
            sessionPrefix: "demo42",
            repo: "acme/demo",
          },
        },
        notifiers: {},
        notificationRouting: { urgent: [], action: [], warning: [], info: [] },
        reactions: {},
      },
      configPath,
    );

    syncProjectShadow(
      "demo",
      {
        repo: "acme/demo",
        defaultBranch: "main",
        agent: "codex",
        runtime: "tmux",
      },
      configPath,
    );

    const globalConfig = loadGlobalConfig(configPath);
    expect(globalConfig?.projects["demo"]).toMatchObject({
      name: "Demo",
      path: "/tmp/demo",
      sessionPrefix: "demo42",
      repo: "acme/demo",
      defaultBranch: "main",
      agent: "codex",
      runtime: "tmux",
    });
  });

  describe("getGlobalConfigPath", () => {
    const origEnv = process.env;

    afterEach(() => {
      process.env = origEnv;
    });

    it("returns default path when no env vars are set", () => {
      process.env = { ...origEnv };
      delete process.env["AO_GLOBAL_CONFIG"];
      delete process.env["XDG_CONFIG_HOME"];
      const path = getGlobalConfigPath();
      expect(path).toContain(".agent-orchestrator");
      expect(path).toContain("config.yaml");
    });

    it("uses AO_GLOBAL_CONFIG when set", () => {
      process.env = { ...origEnv, AO_GLOBAL_CONFIG: "/custom/path/config.yaml" };
      expect(getGlobalConfigPath()).toBe("/custom/path/config.yaml");
    });

    it("uses XDG_CONFIG_HOME when set and AO_GLOBAL_CONFIG is not", () => {
      process.env = { ...origEnv, XDG_CONFIG_HOME: "/xdg/config" };
      delete process.env["AO_GLOBAL_CONFIG"];
      expect(getGlobalConfigPath()).toBe("/xdg/config/agent-orchestrator/config.yaml");
    });
  });

  describe("loadGlobalConfig", () => {
    it("returns null when config file does not exist", () => {
      expect(loadGlobalConfig("/nonexistent/config.yaml")).toBeNull();
    });

    it("returns null for empty YAML", () => {
      writeFileSync(configPath, "");
      expect(loadGlobalConfig(configPath)).toBeNull();
    });

    it("returns null for non-object YAML", () => {
      writeFileSync(configPath, "just a string\n");
      expect(loadGlobalConfig(configPath)).toBeNull();
    });

    it("expands tilde in project paths", () => {
      writeFileSync(
        configPath,
        "projects:\n  myproj:\n    path: ~/my-project\n",
      );
      const config = loadGlobalConfig(configPath);
      expect(config).not.toBeNull();
      expect(config!.projects["myproj"].path).not.toContain("~");
      expect(config!.projects["myproj"].path).toContain("my-project");
    });

    it("loads valid config with defaults", () => {
      writeFileSync(configPath, "projects: {}\n");
      const config = loadGlobalConfig(configPath);
      expect(config).not.toBeNull();
      expect(config!.port).toBe(3000);
      expect(config!.readyThresholdMs).toBe(300_000);
    });
  });

  describe("saveGlobalConfig", () => {
    it("creates parent directories if needed", () => {
      const nestedPath = join(tempRoot, "sub", "dir", "config.yaml");
      const config: GlobalConfig = {
        port: 3000,
        readyThresholdMs: 300_000,
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: {},
        notifiers: {},
        notificationRouting: {},
        reactions: {},
      };
      saveGlobalConfig(config, nestedPath);
      const loaded = loadGlobalConfig(nestedPath);
      expect(loaded).not.toBeNull();
      expect(loaded!.port).toBe(3000);
    });
  });

  describe("loadLocalProjectConfig", () => {
    it("returns null when no config file exists", () => {
      expect(loadLocalProjectConfig(tempRoot)).toBeNull();
    });

    it("loads a valid .yaml config", () => {
      writeFileSync(
        join(tempRoot, "agent-orchestrator.yaml"),
        "repo: acme/foo\nagent: claude-code\n",
      );
      const result = loadLocalProjectConfig(tempRoot);
      expect(result).not.toBeNull();
      expect(result!.repo).toBe("acme/foo");
      expect(result!.agent).toBe("claude-code");
    });

    it("loads a valid .yml config", () => {
      writeFileSync(
        join(tempRoot, "agent-orchestrator.yml"),
        "repo: acme/bar\n",
      );
      const result = loadLocalProjectConfig(tempRoot);
      expect(result).not.toBeNull();
      expect(result!.repo).toBe("acme/bar");
    });

    it("returns null for old format with projects wrapper", () => {
      writeFileSync(
        join(tempRoot, "agent-orchestrator.yaml"),
        "projects:\n  myproj:\n    path: /tmp/foo\n    repo: acme/foo\n",
      );
      expect(loadLocalProjectConfig(tempRoot)).toBeNull();
    });

    it("returns null for malformed YAML", () => {
      writeFileSync(
        join(tempRoot, "agent-orchestrator.yaml"),
        "{{invalid yaml::",
      );
      expect(loadLocalProjectConfig(tempRoot)).toBeNull();
    });

    it("returns null for non-object YAML content", () => {
      writeFileSync(
        join(tempRoot, "agent-orchestrator.yaml"),
        "just a string",
      );
      expect(loadLocalProjectConfig(tempRoot)).toBeNull();
    });
  });

  describe("syncProjectShadow", () => {
    it("creates new project entry when none exists", () => {
      syncProjectShadow(
        "new-proj",
        { repo: "acme/new", agent: "codex" },
        configPath,
      );

      const config = loadGlobalConfig(configPath);
      expect(config).not.toBeNull();
      expect(config!.projects["new-proj"]).toMatchObject({
        path: "",
        repo: "acme/new",
        agent: "codex",
      });
      expect(config!.projects["new-proj"]["_shadowSyncedAt"]).toBeDefined();
    });

    it("excludes secret-like fields with warning", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      syncProjectShadow(
        "proj",
        { repo: "acme/foo", githubToken: "secret123" } as Record<string, unknown> as Parameters<typeof syncProjectShadow>[1],
        configPath,
      );

      const config = loadGlobalConfig(configPath);
      expect(config!.projects["proj"]["githubToken"]).toBeUndefined();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("githubToken"),
      );

      stderrSpy.mockRestore();
    });

    it("excludes internal fields starting with _", () => {
      syncProjectShadow(
        "proj",
        { repo: "acme/foo", _internal: "hidden" } as Record<string, unknown> as Parameters<typeof syncProjectShadow>[1],
        configPath,
      );

      const config = loadGlobalConfig(configPath);
      expect(config!.projects["proj"]["_internal"]).toBeUndefined();
    });

    it("excludes identity fields (name, path, sessionPrefix)", () => {
      // Pre-create with identity fields
      saveGlobalConfig(
        {
          port: 3000,
          readyThresholdMs: 300_000,
          defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
          projects: { proj: { name: "Original", path: "/original/path" } },
          notifiers: {},
          notificationRouting: {},
          reactions: {},
        },
        configPath,
      );

      syncProjectShadow(
        "proj",
        { name: "Override", path: "/new/path", repo: "acme/foo" } as Record<string, unknown> as Parameters<typeof syncProjectShadow>[1],
        configPath,
      );

      const config = loadGlobalConfig(configPath);
      expect(config!.projects["proj"].name).toBe("Original");
      expect(config!.projects["proj"].path).toBe("/original/path");
    });
  });

  describe("registerProjectInGlobalConfig", () => {
    it("registers a new project", () => {
      registerProjectInGlobalConfig("my-proj", "My Project", "/tmp/my-proj", undefined, configPath);

      const config = loadGlobalConfig(configPath);
      expect(config).not.toBeNull();
      expect(config!.projects["my-proj"]).toMatchObject({
        name: "My Project",
        path: "/tmp/my-proj",
      });
    });

    it("preserves existing shadow fields on re-registration", () => {
      // First register with local config
      registerProjectInGlobalConfig(
        "proj",
        "Project",
        "/tmp/proj",
        { repo: "acme/proj", agent: "codex" },
        configPath,
      );

      // Re-register with new name but no local config
      registerProjectInGlobalConfig("proj", "Updated Name", "/tmp/proj-new", undefined, configPath);

      const config = loadGlobalConfig(configPath);
      expect(config!.projects["proj"].name).toBe("Updated Name");
      expect(config!.projects["proj"].path).toBe("/tmp/proj-new");
      // Shadow fields preserved from first registration
      expect(config!.projects["proj"]["repo"]).toBe("acme/proj");
    });

    it("syncs shadow immediately when localConfig is provided", () => {
      registerProjectInGlobalConfig(
        "proj",
        "Project",
        "/tmp/proj",
        { repo: "acme/proj", agent: "aider" },
        configPath,
      );

      const config = loadGlobalConfig(configPath);
      expect(config!.projects["proj"]["agent"]).toBe("aider");
      expect(config!.projects["proj"]["_shadowSyncedAt"]).toBeDefined();
    });

    it("rejects path collisions across different project ids", () => {
      registerProjectInGlobalConfig("proj-a", "Project A", "/tmp/shared", undefined, configPath);

      expect(() =>
        registerProjectInGlobalConfig("proj-b", "Project B", "/tmp/shared", undefined, configPath),
      ).toThrow('Project path "/tmp/shared" is already registered as "proj-a"');
    });
  });

  describe("buildEffectiveProjectConfig", () => {
    it("returns null when project not in global config", () => {
      const globalConfig: GlobalConfig = {
        port: 3000,
        readyThresholdMs: 300_000,
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: {},
        notifiers: {},
        notificationRouting: {},
        reactions: {},
      };
      expect(buildEffectiveProjectConfig("nonexistent", globalConfig)).toBeNull();
    });

    it("returns null when project entry has no path", () => {
      const globalConfig: GlobalConfig = {
        port: 3000,
        readyThresholdMs: 300_000,
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: { proj: { path: "" } },
        notifiers: {},
        notificationRouting: {},
        reactions: {},
      };
      expect(buildEffectiveProjectConfig("proj", globalConfig)).toBeNull();
    });

    it("falls back to shadow when local config is absent", () => {
      const globalConfig: GlobalConfig = {
        port: 3000,
        readyThresholdMs: 300_000,
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: {
          proj: {
            path: "/nonexistent/project/path",
            name: "Shadow Project",
            repo: "acme/shadow",
            _shadowSyncedAt: 1000,
          },
        },
        notifiers: {},
        notificationRouting: {},
        reactions: {},
      };
      const result = buildEffectiveProjectConfig("proj", globalConfig);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("Shadow Project");
      expect(result!.path).toBe("/nonexistent/project/path");
      expect(result!["repo"]).toBe("acme/shadow");
      // _shadowSyncedAt should be stripped
      expect(result!["_shadowSyncedAt"]).toBeUndefined();
    });

    it("uses projectId as name when entry has no name", () => {
      const globalConfig: GlobalConfig = {
        port: 3000,
        readyThresholdMs: 300_000,
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: {
          "my-proj": { path: "/nonexistent/path" },
        },
        notifiers: {},
        notificationRouting: {},
        reactions: {},
      };
      const result = buildEffectiveProjectConfig("my-proj", globalConfig);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("my-proj");
    });

    it("merges local config over shadow when local config exists", () => {
      // Create a project dir with a local config
      const projectDir = join(tempRoot, "project-with-local");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(projectDir, "agent-orchestrator.yaml"),
        "repo: acme/local\nagent: aider\n",
      );

      const globalConfig: GlobalConfig = {
        port: 3000,
        readyThresholdMs: 300_000,
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: {
          proj: {
            path: projectDir,
            name: "My Proj",
            repo: "acme/shadow",
            agent: "codex",
            _shadowSyncedAt: 1000,
          },
        },
        notifiers: {},
        notificationRouting: {},
        reactions: {},
      };

      const result = buildEffectiveProjectConfig("proj", globalConfig);
      expect(result).not.toBeNull();
      // Local overrides shadow
      expect(result!["repo"]).toBe("acme/local");
      expect(result!["agent"]).toBe("aider");
      // Identity from global
      expect(result!.name).toBe("My Proj");
      expect(result!.path).toBe(projectDir);
    });
  });

  describe("isProjectShadowStale", () => {
    it("returns false when project not in config", () => {
      const globalConfig: GlobalConfig = {
        port: 3000,
        readyThresholdMs: 300_000,
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: {},
        notifiers: {},
        notificationRouting: {},
        reactions: {},
      };
      expect(isProjectShadowStale("nonexistent", globalConfig)).toBe(false);
    });

    it("returns true when _shadowSyncedAt is not set (never synced)", () => {
      const globalConfig: GlobalConfig = {
        port: 3000,
        readyThresholdMs: 300_000,
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: {
          proj: { path: tempRoot },
        },
        notifiers: {},
        notificationRouting: {},
        reactions: {},
      };
      expect(isProjectShadowStale("proj", globalConfig)).toBe(true);
    });

    it("returns true when local config is newer than shadow sync", () => {
      const localConfigPath = join(tempRoot, "agent-orchestrator.yaml");
      writeFileSync(localConfigPath, "repo: acme/foo\n");
      // Set mtime to future
      const futureTime = new Date(Date.now() + 60_000);
      utimesSync(localConfigPath, futureTime, futureTime);

      const globalConfig: GlobalConfig = {
        port: 3000,
        readyThresholdMs: 300_000,
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: {
          proj: { path: tempRoot, _shadowSyncedAt: Math.floor(Date.now() / 1000) - 120 },
        },
        notifiers: {},
        notificationRouting: {},
        reactions: {},
      };
      expect(isProjectShadowStale("proj", globalConfig)).toBe(true);
    });

    it("returns false when shadow sync is newer than local config", () => {
      const localConfigPath = join(tempRoot, "agent-orchestrator.yaml");
      writeFileSync(localConfigPath, "repo: acme/foo\n");
      // Set mtime to past
      const pastTime = new Date(Date.now() - 120_000);
      utimesSync(localConfigPath, pastTime, pastTime);

      const globalConfig: GlobalConfig = {
        port: 3000,
        readyThresholdMs: 300_000,
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: {
          proj: { path: tempRoot, _shadowSyncedAt: Math.floor(Date.now() / 1000) + 60 },
        },
        notifiers: {},
        notificationRouting: {},
        reactions: {},
      };
      expect(isProjectShadowStale("proj", globalConfig)).toBe(false);
    });

    it("returns false when no local config file exists", () => {
      const emptyDir = join(tempRoot, "empty-project");
      mkdirSync(emptyDir, { recursive: true });

      const globalConfig: GlobalConfig = {
        port: 3000,
        readyThresholdMs: 300_000,
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: {
          proj: { path: emptyDir, _shadowSyncedAt: 1000 },
        },
        notifiers: {},
        notificationRouting: {},
        reactions: {},
      };
      expect(isProjectShadowStale("proj", globalConfig)).toBe(false);
    });
  });

  describe("isOldConfigFormat", () => {
    it("returns false for null/undefined", () => {
      expect(isOldConfigFormat(null)).toBe(false);
      expect(isOldConfigFormat(undefined)).toBe(false);
    });

    it("returns false for non-object", () => {
      expect(isOldConfigFormat("string")).toBe(false);
      expect(isOldConfigFormat(42)).toBe(false);
    });

    it("returns false when no projects key", () => {
      expect(isOldConfigFormat({ port: 3000 })).toBe(false);
    });

    it("returns false when projects is not an object", () => {
      expect(isOldConfigFormat({ projects: "string" })).toBe(false);
    });

    it("returns false when projects entries have no path", () => {
      expect(isOldConfigFormat({ projects: { foo: { repo: "acme/foo" } } })).toBe(false);
    });

    it("returns true when projects entries have path (old format)", () => {
      expect(
        isOldConfigFormat({
          projects: { foo: { path: "/tmp/foo", repo: "acme/foo" } },
        }),
      ).toBe(true);
    });

    it("returns true for entries that are null/undefined among valid ones", () => {
      expect(
        isOldConfigFormat({
          projects: { foo: null, bar: { path: "/tmp/bar" } },
        }),
      ).toBe(true);
    });
  });

  describe("migrateToGlobalConfig", () => {
    it("throws when file is not old format", () => {
      const oldPath = join(tempRoot, "agent-orchestrator.yaml");
      writeFileSync(oldPath, "repo: acme/foo\n");
      expect(() => migrateToGlobalConfig(oldPath, configPath)).toThrow(
        "not an old-format config",
      );
    });

    it("migrates old format to global + local configs", () => {
      // Create a project directory that matches the config directory
      const projectDir = tempRoot;
      const oldPath = join(projectDir, "agent-orchestrator.yaml");
      writeFileSync(
        oldPath,
        [
          "port: 4000",
          "defaults:",
          "  agent: aider",
          "  runtime: tmux",
          "  workspace: worktree",
          "  notifiers: [desktop]",
          "projects:",
          `  myproj:`,
          `    name: My Project`,
          `    path: ${projectDir}`,
          `    repo: acme/myproj`,
          `    agent: codex`,
          "",
        ].join("\n"),
      );

      const result = migrateToGlobalConfig(oldPath, configPath);
      expect(result).toBe(configPath);

      // Verify global config was written
      const globalConfig = loadGlobalConfig(configPath);
      expect(globalConfig).not.toBeNull();
      expect(globalConfig!.port).toBe(4000);
      expect(globalConfig!.projects["myproj"]).toBeDefined();
      expect(globalConfig!.projects["myproj"].name).toBe("My Project");
      expect(globalConfig!.projects["myproj"].path).toBe(projectDir);
      expect(globalConfig!.projects["myproj"]["repo"]).toBe("acme/myproj");
      expect(globalConfig!.projects["myproj"]["_shadowSyncedAt"]).toBeDefined();

      // Verify local config was rewritten to flat format
      const localConfig = loadLocalProjectConfig(projectDir);
      expect(localConfig).not.toBeNull();
      expect(localConfig!.repo).toBe("acme/myproj");
      expect(localConfig!.agent).toBe("codex");
      // Identity fields should NOT be in the local config
      expect((localConfig as Record<string, unknown>)["name"]).toBeUndefined();
      expect((localConfig as Record<string, unknown>)["path"]).toBeUndefined();
    });

    it("skips projects without path during migration", () => {
      const oldPath = join(tempRoot, "agent-orchestrator.yaml");
      writeFileSync(
        oldPath,
        [
          "projects:",
          "  nopath:",
          "    repo: acme/nopath",
          "  haspath:",
          "    path: /tmp/haspath",
          "    repo: acme/haspath",
          "",
        ].join("\n"),
      );

      migrateToGlobalConfig(oldPath, configPath);
      const globalConfig = loadGlobalConfig(configPath);
      expect(globalConfig!.projects["nopath"]).toBeUndefined();
      expect(globalConfig!.projects["haspath"]).toBeDefined();
    });

    it("excludes secret-like fields during migration", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const oldPath = join(tempRoot, "agent-orchestrator.yaml");
      writeFileSync(
        oldPath,
        [
          "projects:",
          "  proj:",
          "    path: /tmp/proj",
          "    repo: acme/proj",
          "    githubToken: secret123",
          "",
        ].join("\n"),
      );

      migrateToGlobalConfig(oldPath, configPath);
      const globalConfig = loadGlobalConfig(configPath);
      expect(globalConfig!.projects["proj"]["githubToken"]).toBeUndefined();
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("githubToken"));
      stderrSpy.mockRestore();
    });

    it("preserves global operational settings during migration", () => {
      const oldPath = join(tempRoot, "agent-orchestrator.yaml");
      writeFileSync(
        oldPath,
        [
          "port: 8080",
          "terminalPort: 9090",
          "directTerminalPort: 9091",
          "readyThresholdMs: 600000",
          "notifiers:",
          "  slack:",
          "    plugin: slack",
          "notificationRouting:",
          "  urgent: [slack]",
          "reactions:",
          "  ci_failed:",
          "    enabled: true",
          "projects:",
          "  proj:",
          "    path: /tmp/proj",
          "    repo: acme/proj",
          "",
        ].join("\n"),
      );

      migrateToGlobalConfig(oldPath, configPath);
      const globalConfig = loadGlobalConfig(configPath);
      expect(globalConfig!.port).toBe(8080);
      expect(globalConfig!.terminalPort).toBe(9090);
      expect(globalConfig!.directTerminalPort).toBe(9091);
      expect(globalConfig!.readyThresholdMs).toBe(600000);
      expect(globalConfig!.notifiers["slack"]).toBeDefined();
      expect(globalConfig!.notificationRouting["urgent"]).toEqual(["slack"]);
      expect(globalConfig!.reactions["ci_failed"]).toBeDefined();
    });

    it("expands tilde in project path during migration", () => {
      const oldPath = join(tempRoot, "agent-orchestrator.yaml");
      writeFileSync(
        oldPath,
        [
          "projects:",
          "  proj:",
          "    path: ~/my-project",
          "    repo: acme/proj",
          "",
        ].join("\n"),
      );

      migrateToGlobalConfig(oldPath, configPath);
      const globalConfig = loadGlobalConfig(configPath);
      expect(globalConfig!.projects["proj"].path).not.toContain("~");
      expect(globalConfig!.projects["proj"].path).toContain("my-project");
    });
  });
});
