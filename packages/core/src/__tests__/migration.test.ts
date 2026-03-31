/**
 * Unit tests for migration.ts — old format detection, migration, effective config builder.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";

import { needsMigration, migrateToMultiProject, buildEffectiveConfig } from "../migration.js";
import {
  findGlobalConfigPath,
  loadShadowFile,
  saveShadowFile,
  type GlobalConfig,
} from "../global-config.js";

let testDir: string;
let projectDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  testDir = join(tmpdir(), `ao-mig-test-${randomBytes(6).toString("hex")}`);
  projectDir = join(testDir, "my-app");
  mkdirSync(projectDir, { recursive: true });

  // Point global config to test dir
  originalEnv = process.env["AO_GLOBAL_CONFIG_PATH"];
  process.env["AO_GLOBAL_CONFIG_PATH"] = join(testDir, ".agent-orchestrator", "config.yaml");
});

afterEach(() => {
  if (originalEnv !== undefined) {
    process.env["AO_GLOBAL_CONFIG_PATH"] = originalEnv;
  } else {
    delete process.env["AO_GLOBAL_CONFIG_PATH"];
  }
  rmSync(testDir, { recursive: true, force: true });
});

function writeOldConfig(projects: Record<string, Record<string, unknown>>): string {
  const configPath = join(projectDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, stringifyYaml({ projects }), "utf-8");
  return configPath;
}

describe("needsMigration", () => {
  it("returns true for old-format config", () => {
    const configPath = writeOldConfig({
      "my-app": { name: "My App", repo: "org/my-app", path: projectDir },
    });
    expect(needsMigration(configPath)).toBe(true);
  });

  it("returns false for non-existent file", () => {
    expect(needsMigration("/nonexistent/config.yaml")).toBe(false);
  });

  it("returns false for identity-only config", () => {
    const configPath = join(projectDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, stringifyYaml({
      projects: { "my-app": { name: "My App", path: projectDir } },
    }), "utf-8");
    expect(needsMigration(configPath)).toBe(false);
  });

  it("returns false for flat local config", () => {
    const configPath = join(projectDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, stringifyYaml({ repo: "org/my-app" }), "utf-8");
    expect(needsMigration(configPath)).toBe(false);
  });
});

describe("migrateToMultiProject", () => {
  it("migrates old config to global registry + shadow files", () => {
    const configPath = writeOldConfig({
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: projectDir,
        agent: "claude-code",
        runtime: "tmux",
      },
    });

    const result = migrateToMultiProject(configPath);
    expect(result.migrated).toBe(true);
    expect(result.registeredProjects.length).toBeGreaterThan(0);

    // Global config created with identity-only entry
    const globalPath = findGlobalConfigPath();
    expect(existsSync(globalPath)).toBe(true);
    const raw = parseYaml(readFileSync(globalPath, "utf-8")) as any;
    const projectId = result.registeredProjects[0];
    expect(raw.projects[projectId]).toBeDefined();
    // Should NOT have behavior fields inline
    expect(raw.projects[projectId].repo).toBeUndefined();
    expect(raw.projects[projectId].agent).toBeUndefined();

    // Shadow file created with behavior fields
    const shadow = loadShadowFile(projectId);
    expect(shadow).not.toBeNull();
    expect(shadow!["repo"]).toBe("org/my-app");
    expect(shadow!["agent"]).toBe("claude-code");
    expect(shadow!["_shadowSyncedAt"]).toBeDefined();
  });

  it("backs up original config", () => {
    const configPath = writeOldConfig({
      "my-app": { name: "My App", repo: "org/my-app", path: projectDir },
    });
    migrateToMultiProject(configPath);
    expect(existsSync(configPath + ".pre-multiproject.bak")).toBe(true);
  });

  it("writes flat local config", () => {
    const configPath = writeOldConfig({
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: projectDir,
        agent: "claude-code",
      },
    });
    migrateToMultiProject(configPath);

    // The flat local config should exist and have no identity fields
    const localPath = join(projectDir, "agent-orchestrator.yaml");
    expect(existsSync(localPath)).toBe(true);
    const local = parseYaml(readFileSync(localPath, "utf-8")) as any;
    expect(local.repo).toBe("org/my-app");
    expect(local.name).toBeUndefined();
    expect(local.path).toBeUndefined();
  });

  it("handles ID collisions with suffix", () => {
    // Create two projects that would derive the same ID
    const dir2 = join(testDir, "my-app2");
    mkdirSync(dir2, { recursive: true });
    const configPath = writeOldConfig({
      "app1": { name: "App 1", repo: "org/app1", path: projectDir },
      "app2": { name: "App 2", repo: "org/app2", path: projectDir },
    });
    const result = migrateToMultiProject(configPath);
    expect(result.registeredProjects.length).toBe(2);
    // IDs should be different
    expect(result.registeredProjects[0]).not.toBe(result.registeredProjects[1]);
  });

  it("returns migrated=false for non-old-format", () => {
    const configPath = join(projectDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, stringifyYaml({ repo: "org/app" }), "utf-8");
    const result = migrateToMultiProject(configPath);
    expect(result.migrated).toBe(false);
  });

  it("excludes secret fields from shadow", () => {
    const configPath = writeOldConfig({
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: projectDir,
        apiToken: "secret-value",
      },
    });
    const result = migrateToMultiProject(configPath);
    const shadow = loadShadowFile(result.registeredProjects[0]);
    expect(shadow!["apiToken"]).toBeUndefined();
    expect(result.warnings.some((w) => w.includes("apiToken"))).toBe(true);
  });

  it("preserves existing global config projects", () => {
    // Pre-create a global config with an existing project
    const globalDir = join(testDir, ".agent-orchestrator");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, "config.yaml"),
      stringifyYaml({
        projects: { existing: { name: "Existing", path: "/tmp/existing" } },
      }),
      "utf-8",
    );

    const configPath = writeOldConfig({
      "my-app": { name: "My App", repo: "org/my-app", path: projectDir },
    });
    migrateToMultiProject(configPath);

    const raw = parseYaml(readFileSync(join(globalDir, "config.yaml"), "utf-8")) as any;
    expect(raw.projects["existing"]).toBeDefined();
  });
});

describe("buildEffectiveConfig", () => {
  it("builds config from global registry + shadow files", () => {
    const globalConfig: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: projectDir } },
      notifiers: {},
      notificationRouting: {},
      reactions: {},
    };

    // Create shadow file
    saveShadowFile("ao", { repo: "org/ao", agent: "codex", defaultBranch: "develop" });

    const config = buildEffectiveConfig(globalConfig, findGlobalConfigPath());
    expect(config.projects["ao"]).toBeDefined();
    expect(config.projects["ao"].repo).toBe("org/ao");
    expect(config.projects["ao"].agent).toBe("codex");
    expect(config.projects["ao"].defaultBranch).toBe("develop");
    expect(config.projects["ao"].name).toBe("AO");
    expect(config.projects["ao"].path).toBe(projectDir);
  });

  it("returns empty behavior when shadow file is missing", () => {
    const globalConfig: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: projectDir } },
      notifiers: {},
      notificationRouting: {},
      reactions: {},
    };

    const config = buildEffectiveConfig(globalConfig, findGlobalConfigPath());
    expect(config.projects["ao"].repo).toBe("");
    expect(config.projects["ao"].defaultBranch).toBe("main");
  });

  it("prefers local config in hybrid mode", () => {
    // Create local config
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/local", agent: "aider", defaultBranch: "main" }),
      "utf-8",
    );

    // Create shadow with different values
    saveShadowFile("ao", { repo: "org/shadow", agent: "codex" });

    const globalConfig: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: projectDir } },
      notifiers: {},
      notificationRouting: {},
      reactions: {},
    };

    const config = buildEffectiveConfig(globalConfig, findGlobalConfigPath());
    // Should use local config (hybrid mode), not shadow
    expect(config.projects["ao"].repo).toBe("org/local");
    expect(config.projects["ao"].agent).toBe("aider");
  });

  it("sets configMode on each project", () => {
    const globalConfig: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: projectDir } },
      notifiers: {},
      notificationRouting: {},
      reactions: {},
    };

    // No local config → global-only
    const config = buildEffectiveConfig(globalConfig, findGlobalConfigPath());
    expect(config.projects["ao"].configMode).toBe("global-only");
  });

  it("falls back to shadow when local config is invalid", () => {
    // Write invalid local config
    writeFileSync(join(projectDir, "agent-orchestrator.yaml"), "{{invalid yaml", "utf-8");

    saveShadowFile("ao", { repo: "org/shadow", agent: "codex", defaultBranch: "main" });

    const globalConfig: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: projectDir } },
      notifiers: {},
      notificationRouting: {},
      reactions: {},
    };

    const config = buildEffectiveConfig(globalConfig, findGlobalConfigPath());
    // Should fall back to shadow
    expect(config.projects["ao"].repo).toBe("org/shadow");
  });

  it("handles project with missing path gracefully", () => {
    const globalConfig: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: "/nonexistent/path" } },
      notifiers: {},
      notificationRouting: {},
      reactions: {},
    };

    // Should not throw
    const config = buildEffectiveConfig(globalConfig, findGlobalConfigPath());
    expect(config.projects["ao"]).toBeDefined();
    expect(config.projects["ao"].configMode).toBe("global-only");
  });

  it("sets globalConfigPath on returned config", () => {
    const globalConfig: GlobalConfig = {
      port: 4000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {},
      notifiers: {},
      notificationRouting: {},
      reactions: {},
    };
    const globalPath = findGlobalConfigPath();
    const config = buildEffectiveConfig(globalConfig, globalPath);
    expect(config.globalConfigPath).toBe(globalPath);
    expect(config.port).toBe(4000);
  });
});
