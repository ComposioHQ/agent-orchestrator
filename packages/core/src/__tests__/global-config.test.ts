/**
 * Unit tests for global-config.ts — multi-project registry, shadow files, sync.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";

// We test functions via direct import since they use env vars for paths
import {
  findGlobalConfigPath,
  loadGlobalConfig,
  saveGlobalConfig,
  scaffoldGlobalConfig,
  registerProject,
  unregisterProject,
  detectConfigMode,
  syncShadow,
  matchProjectByCwd,
  getShadowDir,
  getShadowFilePath,
  loadShadowFile,
  saveShadowFile,
  deleteShadowFile,
  isSecretField,
  filterSecrets,
  type GlobalConfig,
} from "../global-config.js";

// Use a unique temp dir per test run to avoid conflicts
let testDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  testDir = join(tmpdir(), `ao-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(testDir, { recursive: true });
  originalEnv = process.env["AO_GLOBAL_CONFIG_PATH"];
  process.env["AO_GLOBAL_CONFIG_PATH"] = join(testDir, "config.yaml");
});

afterEach(() => {
  if (originalEnv !== undefined) {
    process.env["AO_GLOBAL_CONFIG_PATH"] = originalEnv;
  } else {
    delete process.env["AO_GLOBAL_CONFIG_PATH"];
  }
  rmSync(testDir, { recursive: true, force: true });
});

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(join(testDir, "config.yaml"), stringifyYaml(data), "utf-8");
}

describe("findGlobalConfigPath", () => {
  it("uses AO_GLOBAL_CONFIG_PATH when set", () => {
    const path = findGlobalConfigPath();
    expect(path).toBe(join(testDir, "config.yaml"));
  });
});

describe("loadGlobalConfig / saveGlobalConfig", () => {
  it("returns null when file does not exist", () => {
    expect(loadGlobalConfig()).toBeNull();
  });

  it("loads a valid config", () => {
    writeConfig({
      projects: {
        ao: { name: "Agent Orchestrator", path: "/tmp/ao" },
      },
    });
    const config = loadGlobalConfig();
    expect(config).not.toBeNull();
    expect(config!.projects["ao"].name).toBe("Agent Orchestrator");
  });

  it("throws user-friendly error on invalid config", () => {
    writeFileSync(join(testDir, "config.yaml"), "port: not-a-number\n", "utf-8");
    expect(() => loadGlobalConfig()).toThrow(/Invalid global config/);
  });

  it("saves and reloads config", () => {
    const config: GlobalConfig = {
      port: 4000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { test: { name: "Test", path: "/tmp/test" } },
    };
    saveGlobalConfig(config);
    const loaded = loadGlobalConfig();
    expect(loaded!.port).toBe(4000);
    expect(loaded!.projects["test"].name).toBe("Test");
  });
});

describe("scaffoldGlobalConfig", () => {
  it("creates a minimal config file", () => {
    const config = scaffoldGlobalConfig();
    expect(config.projects).toEqual({});
    expect(existsSync(join(testDir, "config.yaml"))).toBe(true);
  });
});

describe("registerProject / unregisterProject", () => {
  it("registers a project immutably", () => {
    const original: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {},
    };
    const updated = registerProject(original, "ao", { name: "AO", path: "/tmp/ao" });
    expect(updated.projects["ao"]).toBeDefined();
    expect(original.projects["ao"]).toBeUndefined(); // immutable
  });

  it("unregisters a project (shadow deletion is caller responsibility)", () => {
    saveShadowFile("ao", { repo: "org/ao" });

    const config: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: "/tmp/ao" } },
    };
    const updated = unregisterProject(config, "ao");
    expect(updated.projects["ao"]).toBeUndefined();
    // Shadow file is NOT deleted by unregisterProject — caller does it after save
    expect(existsSync(getShadowFilePath("ao"))).toBe(true);
    // Caller cleans up after successful save
    deleteShadowFile("ao");
    expect(existsSync(getShadowFilePath("ao"))).toBe(false);
  });
});

describe("shadow file I/O", () => {
  it("getShadowDir returns projects/ subdirectory", () => {
    expect(getShadowDir()).toBe(join(testDir, "projects"));
  });

  it("save and load round-trips", () => {
    saveShadowFile("test", { repo: "org/test", agent: "claude-code" });
    const loaded = loadShadowFile("test");
    expect(loaded).not.toBeNull();
    expect(loaded!["repo"]).toBe("org/test");
  });

  it("returns null for missing file", () => {
    expect(loadShadowFile("nonexistent")).toBeNull();
  });

  it("deleteShadowFile removes the file", () => {
    saveShadowFile("test", { repo: "org/test" });
    expect(existsSync(getShadowFilePath("test"))).toBe(true);
    deleteShadowFile("test");
    expect(existsSync(getShadowFilePath("test"))).toBe(false);
  });

  it("deleteShadowFile is safe for missing files", () => {
    expect(() => deleteShadowFile("nonexistent")).not.toThrow();
  });
});

describe("syncShadow", () => {
  it("writes behavior to shadow file, not global config", () => {
    const config: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: "/tmp/ao" } },
    };

    const localConfig = { repo: "org/ao", agent: "claude-code", defaultBranch: "main" } as any;
    const { config: returned, excludedSecrets } = syncShadow(config, "ao", localConfig);

    // Global config unchanged
    expect(returned.projects["ao"]).toEqual(config.projects["ao"]);

    // Shadow file written
    const shadow = loadShadowFile("ao");
    expect(shadow).not.toBeNull();
    expect(shadow!["repo"]).toBe("org/ao");
    expect(shadow!["_shadowSyncedAt"]).toBeDefined();
    expect(excludedSecrets).toEqual([]);
  });

  it("excludes secret-like fields", () => {
    const config: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: "/tmp/ao" } },
    };

    const localConfig = { repo: "org/ao", apiToken: "secret123", defaultBranch: "main" } as any;
    const { excludedSecrets } = syncShadow(config, "ao", localConfig);

    expect(excludedSecrets).toContain("apiToken");
    const shadow = loadShadowFile("ao");
    expect(shadow!["apiToken"]).toBeUndefined();
  });

  it("throws for unregistered project", () => {
    const config: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {},
    };
    expect(() => syncShadow(config, "missing", {} as any)).toThrow(/not found/);
  });
});

describe("matchProjectByCwd", () => {
  it("matches exact path", () => {
    const config: GlobalConfig = {
      port: 3000, readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: testDir } },
    };
    expect(matchProjectByCwd(config, testDir)).toBe("ao");
  });

  it("matches subdirectory", () => {
    const subDir = join(testDir, "src");
    mkdirSync(subDir, { recursive: true });
    const config: GlobalConfig = {
      port: 3000, readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: testDir } },
    };
    expect(matchProjectByCwd(config, subDir)).toBe("ao");
  });

  it("prefers most specific match", () => {
    const subDir = join(testDir, "packages", "sub");
    mkdirSync(subDir, { recursive: true });
    const config: GlobalConfig = {
      port: 3000, readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        parent: { name: "Parent", path: testDir },
        sub: { name: "Sub", path: join(testDir, "packages", "sub") },
      },
    };
    expect(matchProjectByCwd(config, subDir)).toBe("sub");
  });

  it("returns null for unmatched path", () => {
    const config: GlobalConfig = {
      port: 3000, readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: "/some/other/path" } },
    };
    expect(matchProjectByCwd(config, testDir)).toBeNull();
  });
});

describe("isSecretField", () => {
  it("matches common secret patterns", () => {
    expect(isSecretField("apiToken")).toBe(true);
    expect(isSecretField("secretKey")).toBe(true);
    expect(isSecretField("password")).toBe(true);
    expect(isSecretField("API_KEY")).toBe(true);
    expect(isSecretField("dbCredentials")).toBe(true);
    expect(isSecretField("serviceCredential")).toBe(true);
  });

  it("does not match non-secret fields", () => {
    expect(isSecretField("repo")).toBe(false);
    expect(isSecretField("agent")).toBe(false);
    expect(isSecretField("secretEnvVar")).toBe(false);
  });
});

describe("filterSecrets", () => {
  it("recursively filters secret-like fields", () => {
    const excluded: string[] = [];
    const result = filterSecrets(
      { host: "example.com", webhook: { url: "/hook", secretToken: "abc" } },
      excluded,
      "scm",
    );
    expect(result["host"]).toBe("example.com");
    expect((result["webhook"] as any)["url"]).toBe("/hook");
    expect((result["webhook"] as any)["secretToken"]).toBeUndefined();
    expect(excluded).toContain("scm.webhook.secretToken");
  });
});

describe("detectConfigMode", () => {
  it("returns hybrid when local config exists", () => {
    writeFileSync(join(testDir, "agent-orchestrator.yaml"), "repo: org/test\n");
    expect(detectConfigMode(testDir)).toBe("hybrid");
  });

  it("returns global-only when no local config", () => {
    expect(detectConfigMode(testDir)).toBe("global-only");
  });
});
