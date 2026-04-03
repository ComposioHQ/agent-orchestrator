/**
 * Tests for resolveMultiProjectStart — core multi-project registration logic.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";

import { resolveMultiProjectStart } from "../multi-project-start.js";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  loadShadowFile,
  getShadowFilePath,
  type GlobalConfig,
} from "../global-config.js";

let testDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  testDir = join(tmpdir(), `ao-mps-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(testDir, { recursive: true });
  originalEnv = process.env["AO_GLOBAL_CONFIG_PATH"];
  process.env["AO_GLOBAL_CONFIG_PATH"] = join(testDir, ".ao", "config.yaml");
});

afterEach(() => {
  if (originalEnv !== undefined) {
    process.env["AO_GLOBAL_CONFIG_PATH"] = originalEnv;
  } else {
    delete process.env["AO_GLOBAL_CONFIG_PATH"];
  }
  rmSync(testDir, { recursive: true, force: true });
});

function setupGlobalConfig(projects: Record<string, { name: string; path: string }>): void {
  const config: GlobalConfig = {
    port: 3000,
    readyThresholdMs: 300000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects,
  };
  saveGlobalConfig(config);
}

describe("resolveMultiProjectStart", () => {
  it("returns null when no global config exists", () => {
    const result = resolveMultiProjectStart(testDir);
    expect(result).toBeNull();
  });

  it("returns null when CWD has no local config and is not registered", () => {
    setupGlobalConfig({});
    const unregisteredDir = join(testDir, "unregistered");
    mkdirSync(unregisteredDir, { recursive: true });
    const result = resolveMultiProjectStart(unregisteredDir);
    expect(result).toBeNull();
  });

  it("registers a new project with local config (hybrid mode)", () => {
    setupGlobalConfig({});
    const projectDir = join(testDir, "my-app");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/my-app", defaultBranch: "main", agent: "claude-code" }),
    );

    const result = resolveMultiProjectStart(projectDir);
    expect(result).not.toBeNull();
    expect(result!.projectId).toBeTruthy();
    expect(result!.config.projects[result!.projectId]).toBeDefined();

    // Shadow file should be created
    expect(existsSync(getShadowFilePath(result!.projectId))).toBe(true);
    const shadow = loadShadowFile(result!.projectId);
    expect(shadow!["repo"]).toBe("org/my-app");

    // Global config should have the project registered
    const gc = loadGlobalConfig();
    expect(gc!.projects[result!.projectId]).toBeDefined();

    // Messages should include registration info
    expect(result!.messages.some((m) => m.text.includes("Registered"))).toBe(true);
  });

  it("syncs shadow for already-registered hybrid project", () => {
    const projectDir = join(testDir, "existing-app");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/existing", defaultBranch: "main", agent: "aider" }),
    );

    // Register the project first
    setupGlobalConfig({ ea: { name: "Existing App", path: projectDir } });

    const result = resolveMultiProjectStart(projectDir);
    expect(result).not.toBeNull();
    expect(result!.projectId).toBe("ea");

    // Shadow should be synced with local config values
    const shadow = loadShadowFile("ea");
    expect(shadow!["agent"]).toBe("aider");
  });

  it("returns config for already-registered global-only project", () => {
    const projectDir = join(testDir, "global-only");
    mkdirSync(projectDir, { recursive: true });
    // No local config — global-only mode

    setupGlobalConfig({ go: { name: "Global Only", path: projectDir } });

    const result = resolveMultiProjectStart(projectDir);
    expect(result).not.toBeNull();
    expect(result!.projectId).toBe("go");
  });

  it("handles ID collision with auto-suffix", () => {
    const dir1 = join(testDir, "app");
    const dir2 = join(testDir, "other-app");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, "agent-orchestrator.yaml"), stringifyYaml({ repo: "org/other-app", defaultBranch: "main" }));

    // Register first project with the abbreviated ID that dir2 would derive.
    // basename of dir2 is "other-app" → generateSessionPrefix → "oa"
    // "oa" is pre-occupied by dir1 (different path), so dir2 should get "oa2".
    setupGlobalConfig({ oa: { name: "First", path: dir1 } });

    const result = resolveMultiProjectStart(dir2);
    expect(result).not.toBeNull();
    expect(result!.projectId).not.toBe("oa");
    expect(result!.messages.some((m) => m.text.includes("taken"))).toBe(true);
  });

  it("finds local config from subdirectory", () => {
    const projectDir = join(testDir, "sub-test");
    const subDir = join(projectDir, "src", "lib");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/sub-test", defaultBranch: "main" }),
    );

    setupGlobalConfig({});

    const result = resolveMultiProjectStart(subDir);
    expect(result).not.toBeNull();
    // Should register with the project root, not the subdirectory
    const project = result!.config.projects[result!.projectId];
    expect(project.path).toBe(projectDir);
  });

  it("excludes secret-like fields from shadow", () => {
    setupGlobalConfig({});
    const projectDir = join(testDir, "secret-proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/secret", defaultBranch: "main", apiToken: "secret123" }),
    );

    const result = resolveMultiProjectStart(projectDir);
    expect(result).not.toBeNull();

    const shadow = loadShadowFile(result!.projectId);
    expect(shadow!["apiToken"]).toBeUndefined();
    expect(result!.messages.some((m) => m.text.includes("secret"))).toBe(true);
  });

  it("handles double collision — increments suffix past 2 (lines 71-72)", () => {
    // "oa" and "oa2" are both pre-registered under paths whose derived prefixes
    // don't conflict with each other. A new project "other-app" → prefix "oa"
    // should get "oa3" since both "oa" and "oa2" are taken.
    const dir1 = join(testDir, "polar-project");  // prefix "po" — no collision
    const dir2 = join(testDir, "sunny-project");  // prefix "su" — no collision
    const dir3 = join(testDir, "other-app");       // prefix "oa"
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    mkdirSync(dir3, { recursive: true });
    writeFileSync(join(dir3, "agent-orchestrator.yaml"), stringifyYaml({ repo: "org/other-app", defaultBranch: "main" }));

    // Pre-register "oa" and "oa2" under different paths so "other-app" must use "oa3".
    setupGlobalConfig({
      oa: { name: "Polar Project", path: dir1 },
      oa2: { name: "Sunny Project", path: dir2 },
    });

    const result = resolveMultiProjectStart(dir3);
    expect(result).not.toBeNull();
    expect(result!.projectId).toBe("oa3");
    expect(result!.messages.some((m) => m.text.includes("taken"))).toBe(true);
  });

  it("warns when loadLocalProjectConfig throws during new registration (line 101)", () => {
    setupGlobalConfig({});
    const projectDir = join(testDir, "bad-yaml-proj");
    mkdirSync(projectDir, { recursive: true });
    // Write malformed YAML that will cause the YAML parser to throw
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      "{ invalid yaml: [[[unclosed",
    );

    const result = resolveMultiProjectStart(projectDir);
    expect(result).not.toBeNull();
    // Should warn about the sync failure, not crash
    expect(result!.messages.some((m) => m.level === "warn" && m.text.includes("Could not sync"))).toBe(true);
  });

  it("warns when loadLocalProjectConfig throws for already-registered hybrid project (line 122)", () => {
    const projectDir = join(testDir, "existing-bad-yaml");
    mkdirSync(projectDir, { recursive: true });
    // Write malformed YAML
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      "{ invalid yaml: [[[unclosed",
    );

    setupGlobalConfig({ ebp: { name: "Existing Bad Project", path: projectDir } });

    const result = resolveMultiProjectStart(projectDir);
    expect(result).not.toBeNull();
    expect(result!.projectId).toBe("ebp");
    // Should warn about the sync failure
    expect(result!.messages.some((m) => m.level === "warn" && m.text.includes("Shadow sync failed"))).toBe(true);
  });

  it("warns about secret exclusions for already-registered hybrid project (line 119)", () => {
    const projectDir = join(testDir, "registered-secret");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/rs", defaultBranch: "main", apiToken: "secret123" }),
    );

    setupGlobalConfig({ rs: { name: "Registered Secret", path: projectDir } });

    const result = resolveMultiProjectStart(projectDir);
    expect(result).not.toBeNull();
    // Should warn about excluded secret-like fields
    expect(result!.messages.some((m) => m.text.includes("secret") || m.text.includes("apiToken"))).toBe(true);
  });
});
