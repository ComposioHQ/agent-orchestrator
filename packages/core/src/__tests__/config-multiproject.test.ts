/**
 * Tests for loadConfig / loadConfigWithPath multi-project paths.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";

import { loadConfig, loadConfigWithPath } from "../config.js";
import { saveGlobalConfig, saveShadowFile, type GlobalConfig } from "../global-config.js";

let testDir: string;
let projectDir: string;
let originalGlobalEnv: string | undefined;
let originalConfigEnv: string | undefined;

beforeEach(() => {
  testDir = join(tmpdir(), `ao-cfg-test-${randomBytes(6).toString("hex")}`);
  projectDir = join(testDir, "my-app");
  mkdirSync(projectDir, { recursive: true });

  originalGlobalEnv = process.env["AO_GLOBAL_CONFIG_PATH"];
  originalConfigEnv = process.env["AO_CONFIG_PATH"];
  process.env["AO_GLOBAL_CONFIG_PATH"] = join(testDir, ".ao", "config.yaml");
  delete process.env["AO_CONFIG_PATH"];
});

afterEach(() => {
  if (originalGlobalEnv !== undefined) {
    process.env["AO_GLOBAL_CONFIG_PATH"] = originalGlobalEnv;
  } else {
    delete process.env["AO_GLOBAL_CONFIG_PATH"];
  }
  if (originalConfigEnv !== undefined) {
    process.env["AO_CONFIG_PATH"] = originalConfigEnv;
  } else {
    delete process.env["AO_CONFIG_PATH"];
  }
  rmSync(testDir, { recursive: true, force: true });
});

function setupGlobalConfig(projects: Record<string, { name: string; path: string }>): void {
  const config: GlobalConfig = {
    port: 3000,
    readyThresholdMs: 300000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects,
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  };
  saveGlobalConfig(config);
}

describe("loadConfig — multi-project path", () => {
  it("loads from global config + shadow files", () => {
    setupGlobalConfig({ ao: { name: "AO", path: projectDir } });
    saveShadowFile("ao", { repo: "org/ao", agent: "codex", defaultBranch: "main" });

    const config = loadConfig();
    expect(config.projects["ao"]).toBeDefined();
    expect(config.projects["ao"].repo).toBe("org/ao");
    expect(config.projects["ao"].agent).toBe("codex");
    expect(config.globalConfigPath).toBeDefined();
  });

  it("loads with empty project registry", () => {
    setupGlobalConfig({});

    const config = loadConfig();
    expect(Object.keys(config.projects)).toHaveLength(0);
  });

  it("applies defaults to projects from global config", () => {
    setupGlobalConfig({ ao: { name: "AO", path: projectDir } });
    saveShadowFile("ao", { repo: "org/ao", defaultBranch: "main" });

    const config = loadConfig();
    // Default reactions should be applied
    expect(config.reactions["ci-failed"]).toBeDefined();
    // Default SCM should be inferred
    expect(config.projects["ao"].scm).toBeDefined();
  });

  it("falls back to local config when no global config exists", () => {
    // Write a local config file and point AO_CONFIG_PATH to it
    const localPath = join(projectDir, "agent-orchestrator.yaml");
    writeFileSync(localPath, stringifyYaml({
      projects: {
        app: { name: "App", repo: "org/app", path: projectDir },
      },
    }), "utf-8");
    process.env["AO_CONFIG_PATH"] = localPath;
    // Remove global config
    delete process.env["AO_GLOBAL_CONFIG_PATH"];
    process.env["AO_GLOBAL_CONFIG_PATH"] = join(testDir, "nonexistent", "config.yaml");

    const config = loadConfig();
    expect(config.projects["app"]).toBeDefined();
  });

  it("explicit configPath bypasses global config", () => {
    setupGlobalConfig({ ao: { name: "AO", path: projectDir } });

    const localPath = join(projectDir, "agent-orchestrator.yaml");
    writeFileSync(localPath, stringifyYaml({
      projects: {
        local: { name: "Local", repo: "org/local", path: projectDir },
      },
    }), "utf-8");

    const config = loadConfig(localPath);
    expect(config.projects["local"]).toBeDefined();
    expect(config.projects["ao"]).toBeUndefined();
  });
});

describe("loadConfigWithPath — multi-project path", () => {
  it("returns global config path when using multi-project", () => {
    setupGlobalConfig({ ao: { name: "AO", path: projectDir } });
    saveShadowFile("ao", { repo: "org/ao", defaultBranch: "main" });

    const { config, path } = loadConfigWithPath();
    expect(config.projects["ao"]).toBeDefined();
    expect(path).toContain("config.yaml");
  });
});
