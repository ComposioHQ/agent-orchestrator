/**
 * Tests for GlobalConfig types, global config loader, config resolver,
 * local config parser, and migration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GlobalConfig, ProjectRegistryEntry, ProjectShadow, ConfigMode } from "../types.js";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  getGlobalConfigPath,
  globalConfigExists,
  registerProject,
  unregisterProject,
  extractShadow,
  isProjectRegistered,
} from "../global-config.js";
import { resolveMultiProjectConfig } from "../config-resolver.js";
import { isLocalConfig, parseLocalConfig } from "../local-config.js";
import { needsMigration, migrateToMultiProject } from "../migration.js";

// =============================================================================
// Test setup
// =============================================================================

const TEST_DIR = join(tmpdir(), `ao-global-config-test-${process.pid}-${Date.now()}`);
const TEST_CONFIG_DIR = join(TEST_DIR, ".agent-orchestrator");

beforeEach(() => {
  mkdirSync(TEST_CONFIG_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// =============================================================================
// Type-level tests
// =============================================================================

describe("GlobalConfig types", () => {
  it("GlobalConfig has required fields", () => {
    const config: GlobalConfig = {
      version: 1,
      projects: {
        "my-app": {
          name: "my-app",
          id: "my-app",
          path: "/home/user/my-app",
          repo: "org/my-app",
          defaultBranch: "main",
          configMode: "hybrid",
          localConfigPath: "/home/user/my-app/agent-orchestrator.yaml",
        },
      },
      shadows: {},
      daemon: { port: 3000 },
    };
    expect(config.version).toBe(1);
    expect(config.projects["my-app"].configMode).toBe("hybrid");
  });

  it("ProjectRegistryEntry supports global-only mode", () => {
    const entry: ProjectRegistryEntry = {
      name: "docker-project",
      id: "docker-project",
      path: "/opt/projects/docker-project",
      repo: "org/docker-project",
      defaultBranch: "main",
      configMode: "global-only",
    };
    expect(entry.configMode).toBe("global-only");
    expect(entry.localConfigPath).toBeUndefined();
  });

  it("ConfigMode is a string union", () => {
    const hybrid: ConfigMode = "hybrid";
    const globalOnly: ConfigMode = "global-only";
    expect(hybrid).toBe("hybrid");
    expect(globalOnly).toBe("global-only");
  });
});

// =============================================================================
// Global config loader
// =============================================================================

describe("getGlobalConfigPath", () => {
  it("returns path under ~/.agent-orchestrator/", () => {
    const path = getGlobalConfigPath(TEST_DIR);
    expect(path).toBe(join(TEST_DIR, ".agent-orchestrator", "config.yaml"));
  });
});

describe("globalConfigExists", () => {
  it("returns false when no config file", () => {
    expect(globalConfigExists(TEST_DIR)).toBe(false);
  });

  it("returns true when config file exists", () => {
    writeFileSync(
      join(TEST_CONFIG_DIR, "config.yaml"),
      "version: 1\nprojects: {}\nshadows: {}\ndaemon: {}\n",
    );
    expect(globalConfigExists(TEST_DIR)).toBe(true);
  });
});

describe("loadGlobalConfig", () => {
  it("returns default config when file does not exist", () => {
    const config = loadGlobalConfig(TEST_DIR);
    expect(config.version).toBe(1);
    expect(config.projects).toEqual({});
    expect(config.shadows).toEqual({});
  });

  it("loads existing config", () => {
    const yaml = `
version: 1
projects:
  my-app:
    name: my-app
    id: my-app
    path: /home/user/my-app
    repo: org/my-app
    defaultBranch: main
    configMode: hybrid
    localConfigPath: /home/user/my-app/agent-orchestrator.yaml
shadows: {}
daemon:
  port: 4000
`;
    writeFileSync(join(TEST_CONFIG_DIR, "config.yaml"), yaml);
    const config = loadGlobalConfig(TEST_DIR);
    expect(config.projects["my-app"].repo).toBe("org/my-app");
    expect(config.daemon.port).toBe(4000);
  });
});

describe("saveGlobalConfig", () => {
  it("creates config file", () => {
    const config: GlobalConfig = {
      version: 1,
      projects: {},
      shadows: {},
      daemon: { port: 3000 },
    };
    saveGlobalConfig(config, TEST_DIR);
    expect(existsSync(join(TEST_CONFIG_DIR, "config.yaml"))).toBe(true);
  });

  it("round-trips correctly", () => {
    const config: GlobalConfig = {
      version: 1,
      projects: {
        "test-proj": {
          name: "test-proj",
          id: "test-proj",
          path: "/tmp/test-proj",
          repo: "org/test-proj",
          defaultBranch: "main",
          configMode: "hybrid",
          localConfigPath: "/tmp/test-proj/agent-orchestrator.yaml",
        },
      },
      shadows: {},
      daemon: { port: 3000 },
    };
    saveGlobalConfig(config, TEST_DIR);
    const loaded = loadGlobalConfig(TEST_DIR);
    expect(loaded.projects["test-proj"].repo).toBe("org/test-proj");
    expect(loaded.daemon.port).toBe(3000);
  });
});

describe("registerProject", () => {
  it("adds a project to the global config", () => {
    const globalConfig: GlobalConfig = {
      version: 1,
      projects: {},
      shadows: {},
      daemon: {},
    };
    const entry: ProjectRegistryEntry = {
      name: "my-app",
      id: "my-app",
      path: "/tmp/my-app",
      repo: "org/my-app",
      defaultBranch: "main",
      configMode: "hybrid",
    };
    const updated = registerProject(globalConfig, entry);
    expect(updated.projects["my-app"]).toBeDefined();
    expect(updated.projects["my-app"].configMode).toBe("hybrid");
  });

  it("adds shadow config when provided", () => {
    const globalConfig: GlobalConfig = {
      version: 1,
      projects: {},
      shadows: {},
      daemon: {},
    };
    const entry: ProjectRegistryEntry = {
      name: "my-app",
      id: "my-app",
      path: "/tmp/my-app",
      repo: "org/my-app",
      defaultBranch: "main",
      configMode: "hybrid",
    };
    const shadow = { tracker: { plugin: "github" } } as ProjectShadow;
    const updated = registerProject(globalConfig, entry, shadow);
    expect(updated.shadows["my-app"]).toBeDefined();
  });

  it("does not mutate original config", () => {
    const globalConfig: GlobalConfig = {
      version: 1,
      projects: {},
      shadows: {},
      daemon: {},
    };
    const entry: ProjectRegistryEntry = {
      name: "my-app",
      id: "my-app",
      path: "/tmp/my-app",
      repo: "org/my-app",
      defaultBranch: "main",
      configMode: "hybrid",
    };
    registerProject(globalConfig, entry);
    expect(Object.keys(globalConfig.projects)).toHaveLength(0);
  });
});

describe("unregisterProject", () => {
  it("removes a project from global config", () => {
    const globalConfig: GlobalConfig = {
      version: 1,
      projects: {
        "my-app": {
          name: "my-app",
          id: "my-app",
          path: "/tmp/my-app",
          repo: "org/my-app",
          defaultBranch: "main",
          configMode: "hybrid",
        },
      },
      shadows: { "my-app": {} as ProjectShadow },
      daemon: {},
    };
    const updated = unregisterProject(globalConfig, "my-app");
    expect(updated.projects["my-app"]).toBeUndefined();
    expect(updated.shadows["my-app"]).toBeUndefined();
  });
});

describe("isProjectRegistered", () => {
  it("returns true for registered projects", () => {
    const globalConfig: GlobalConfig = {
      version: 1,
      projects: {
        "my-app": {
          name: "my-app",
          id: "my-app",
          path: "/tmp/my-app",
          repo: "org/my-app",
          defaultBranch: "main",
          configMode: "hybrid",
        },
      },
      shadows: {},
      daemon: {},
    };
    expect(isProjectRegistered(globalConfig, "my-app")).toBe(true);
    expect(isProjectRegistered(globalConfig, "unknown")).toBe(false);
  });
});

describe("extractShadow", () => {
  it("strips identity fields from project config", () => {
    const project = {
      name: "My App",
      repo: "org/my-app",
      path: "/tmp/my-app",
      defaultBranch: "main",
      sessionPrefix: "ma",
      agent: "claude-code",
      runtime: "tmux",
      tracker: { plugin: "github" },
    };
    const shadow = extractShadow(project as never);
    expect((shadow as Record<string, unknown>)["name"]).toBeUndefined();
    expect((shadow as Record<string, unknown>)["repo"]).toBeUndefined();
    expect((shadow as Record<string, unknown>)["path"]).toBeUndefined();
    expect((shadow as Record<string, unknown>)["defaultBranch"]).toBeUndefined();
    expect((shadow as Record<string, unknown>)["sessionPrefix"]).toBeUndefined();
    expect((shadow as Record<string, unknown>)["agent"]).toBe("claude-code");
    expect((shadow as Record<string, unknown>)["tracker"]).toEqual({ plugin: "github" });
  });
});

// =============================================================================
// Config resolver
// =============================================================================

describe("resolveMultiProjectConfig", () => {
  it("builds OrchestratorConfig from global registry", () => {
    const global: GlobalConfig = {
      version: 1,
      projects: {
        "my-app": {
          name: "my-app",
          id: "my-app",
          path: "/tmp/my-app",
          repo: "org/my-app",
          defaultBranch: "main",
          configMode: "global-only",
          sessionPrefix: "ma",
        },
      },
      shadows: {},
      daemon: { port: 4000 },
    };

    const config = resolveMultiProjectConfig(global, "/tmp/global-config.yaml");
    expect(config.port).toBe(4000);
    expect(config.projects["my-app"]).toBeDefined();
    expect(config.projects["my-app"].repo).toBe("org/my-app");
    expect(config.projects["my-app"].path).toBe("/tmp/my-app");
    expect(config.configPath).toBe("/tmp/global-config.yaml");
  });

  it("merges shadow config into project config", () => {
    const global: GlobalConfig = {
      version: 1,
      projects: {
        "my-app": {
          name: "my-app",
          id: "my-app",
          path: "/tmp/my-app",
          repo: "org/my-app",
          defaultBranch: "main",
          configMode: "global-only",
          sessionPrefix: "app",
        },
      },
      shadows: {
        "my-app": {
          tracker: { plugin: "github" },
        } as ProjectShadow,
      },
      daemon: {},
    };

    const config = resolveMultiProjectConfig(global, "/tmp/config.yaml");
    expect(config.projects["my-app"].sessionPrefix).toBe("app");
    expect(config.projects["my-app"].tracker?.plugin).toBe("github");
  });

  it("handles multiple projects", () => {
    const global: GlobalConfig = {
      version: 1,
      projects: {
        "app-a": {
          name: "App A",
          id: "app-a",
          path: "/tmp/app-a",
          repo: "org/app-a",
          defaultBranch: "main",
          configMode: "global-only",
          sessionPrefix: "aa",
        },
        "app-b": {
          name: "App B",
          id: "app-b",
          path: "/tmp/app-b",
          repo: "org/app-b",
          defaultBranch: "develop",
          configMode: "global-only",
          sessionPrefix: "ab",
        },
      },
      shadows: {},
      daemon: {},
    };

    const config = resolveMultiProjectConfig(global, "/tmp/config.yaml");
    expect(Object.keys(config.projects)).toHaveLength(2);
    expect(config.projects["app-b"].defaultBranch).toBe("develop");
  });
});

// =============================================================================
// Local config parser
// =============================================================================

describe("isLocalConfig", () => {
  it("detects flat local config (no projects key)", () => {
    expect(isLocalConfig({ agent: "claude-code", runtime: "tmux" })).toBe(true);
  });

  it("detects legacy multi-project config", () => {
    expect(
      isLocalConfig({ projects: { "my-app": { repo: "org/app", path: "~/app" } } }),
    ).toBe(false);
  });

  it("returns false for non-objects", () => {
    expect(isLocalConfig(null)).toBe(false);
    expect(isLocalConfig("string")).toBe(false);
  });
});

describe("parseLocalConfig", () => {
  it("parses flat behavior config", () => {
    const result = parseLocalConfig({
      agent: "claude-code",
      runtime: "tmux",
      tracker: { plugin: "github" },
    });
    expect((result as Record<string, unknown>)["agent"]).toBe("claude-code");
    expect((result as Record<string, unknown>)["tracker"]).toEqual({ plugin: "github" });
  });

  it("strips identity fields", () => {
    const result = parseLocalConfig({
      name: "should-be-stripped",
      repo: "should-be-stripped",
      path: "should-be-stripped",
      agent: "claude-code",
    });
    expect((result as Record<string, unknown>)["name"]).toBeUndefined();
    expect((result as Record<string, unknown>)["repo"]).toBeUndefined();
    expect((result as Record<string, unknown>)["path"]).toBeUndefined();
    expect((result as Record<string, unknown>)["agent"]).toBe("claude-code");
  });
});

// =============================================================================
// Migration
// =============================================================================

describe("needsMigration", () => {
  it("returns true for legacy config with projects wrapper", () => {
    expect(
      needsMigration({ projects: { "my-app": { repo: "org/app", path: "/tmp/app" } } }),
    ).toBe(true);
  });

  it("returns false for flat local config", () => {
    expect(needsMigration({ agent: "claude-code", runtime: "tmux" })).toBe(false);
  });

  it("returns false when all projects already registered", () => {
    expect(
      needsMigration(
        { projects: { "my-app": { repo: "org/app", path: "/tmp/app" } } },
        new Set(["my-app"]),
      ),
    ).toBe(false);
  });

  it("returns true when some projects are new", () => {
    expect(
      needsMigration(
        {
          projects: {
            "my-app": { repo: "org/app", path: "/tmp/app" },
            "new-app": { repo: "org/new", path: "/tmp/new" },
          },
        },
        new Set(["my-app"]),
      ),
    ).toBe(true);
  });
});

describe("migrateToMultiProject", () => {
  it("extracts projects into global registry entries", () => {
    const legacyConfig = {
      port: 3000,
      defaults: { agent: "claude-code", runtime: "tmux", workspace: "worktree" },
      projects: {
        "my-app": {
          name: "My App",
          repo: "org/app",
          path: "/tmp/app",
          defaultBranch: "main",
          sessionPrefix: "ma",
          agent: "claude-code",
          tracker: { plugin: "github" },
        },
      },
    };

    const result = migrateToMultiProject(legacyConfig, "/tmp/agent-orchestrator.yaml");
    expect(result.globalConfig.projects["my-app"]).toBeDefined();
    expect(result.globalConfig.projects["my-app"].repo).toBe("org/app");
    expect(result.globalConfig.projects["my-app"].configMode).toBe("hybrid");
    expect(result.globalConfig.projects["my-app"].localConfigPath).toBe(
      "/tmp/agent-orchestrator.yaml",
    );
    expect(result.globalConfig.shadows["my-app"]).toBeDefined();
    expect(
      (result.globalConfig.shadows["my-app"] as Record<string, unknown>)["tracker"],
    ).toEqual({ plugin: "github" });
    expect(result.globalConfig.daemon.port).toBe(3000);
  });

  it("handles multiple projects", () => {
    const legacyConfig = {
      projects: {
        "app-a": { repo: "org/a", path: "/tmp/a" },
        "app-b": { repo: "org/b", path: "/tmp/b" },
      },
    };

    const result = migrateToMultiProject(legacyConfig, "/tmp/config.yaml");
    expect(Object.keys(result.globalConfig.projects)).toHaveLength(2);
  });

  it("preserves daemon settings", () => {
    const legacyConfig = {
      port: 4000,
      terminalPort: 4001,
      readyThresholdMs: 600000,
      projects: {
        "my-app": { repo: "org/app", path: "/tmp/app" },
      },
    };

    const result = migrateToMultiProject(legacyConfig, "/tmp/config.yaml");
    expect(result.globalConfig.daemon.port).toBe(4000);
    expect(result.globalConfig.daemon.terminalPort).toBe(4001);
    expect(result.globalConfig.daemon.readyThresholdMs).toBe(600000);
  });
});
