import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, findConfigFile } from "../src/config.js";

describe("Config Loading", () => {
  let testDir: string;
  let originalCwd: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Create temp test directory
    testDir = join(tmpdir(), `ao-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Save original state
    originalCwd = process.cwd();
    originalEnv = { ...process.env };

    // Change to test directory
    process.chdir(testDir);
  });

  afterEach(() => {
    // Restore original state
    process.chdir(originalCwd);
    process.env = originalEnv;

    // Cleanup test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  describe("findConfigFile", () => {
    it("should find config in current directory", () => {
      const configPath = join(testDir, "agent-orchestrator.yaml");
      writeFileSync(configPath, "projects: {}");

      const found = findConfigFile();
      // Use realpathSync to handle macOS /var -> /private/var symlink
      expect(realpathSync(found!)).toBe(realpathSync(configPath));
    });

    it("should prioritize AO_CONFIG_PATH env var", () => {
      // Create config in a different location
      const customDir = join(testDir, "custom");
      mkdirSync(customDir);
      const customConfig = join(customDir, "custom-config.yaml");
      writeFileSync(customConfig, "projects: {}");

      // Create config in current directory too
      const localConfig = join(testDir, "agent-orchestrator.yaml");
      writeFileSync(localConfig, "projects: {}");

      // Set env var to point to custom location
      process.env["AO_CONFIG_PATH"] = customConfig;

      const found = findConfigFile();
      expect(found).toBe(customConfig);
    });

    it("should return null if no config found", () => {
      const found = findConfigFile();
      expect(found).toBeNull();
    });
  });

  describe("loadConfig", () => {
    it("should load config from AO_CONFIG_PATH env var", () => {
      const configPath = join(testDir, "test-config.yaml");
      writeFileSync(
        configPath,
        `
port: 4000
projects:
  test-project:
    repo: test/repo
    path: ${testDir}
    defaultBranch: main
`,
      );

      process.env["AO_CONFIG_PATH"] = configPath;

      const config = loadConfig();
      expect(config.port).toBe(4000);
      expect(config.projects["test-project"]).toBeDefined();
    });

    it("should load config from explicit path parameter", () => {
      const configPath = join(testDir, "explicit-config.yaml");
      writeFileSync(
        configPath,
        `
port: 5000
projects:
  explicit-project:
    repo: test/repo
    path: ${testDir}
    defaultBranch: main
`,
      );

      const config = loadConfig(configPath);
      expect(config.port).toBe(5000);
    });

    it("should throw error if config not found", () => {
      expect(() => loadConfig()).toThrow("No agent-orchestrator.yaml found");
    });

    it("applies workflow defaults for projects", () => {
      const configPath = join(testDir, "workflow-defaults.yaml");
      writeFileSync(
        configPath,
        `
projects:
  test-project:
    repo: test/repo
    path: ${testDir}
`,
      );

      const config = loadConfig(configPath);
      expect(config.projects["test-project"]?.workflow?.mode).toBe("simple");
      expect(config.projects["test-project"]?.workflow?.autoCodeReview).toBe(true);
    });

    it("parses explicit full workflow config", () => {
      const configPath = join(testDir, "workflow-full.yaml");
      writeFileSync(
        configPath,
        `
projects:
  test-project:
    repo: test/repo
    path: ${testDir}
    workflow:
      mode: full
      planReview:
        roles: [architect, developer]
        maxRounds: 4
        codexReview: false
`,
      );

      const config = loadConfig(configPath);
      const workflow = config.projects["test-project"]?.workflow;
      expect(workflow?.mode).toBe("full");
      expect(workflow?.planReview?.roles).toEqual(["architect", "developer"]);
      expect(workflow?.planReview?.maxRounds).toBe(4);
      expect(workflow?.planReview?.codexReview).toBe(false);
    });
  });

  describe("Config Discovery Priority", () => {
    it("should use explicit path over env var", () => {
      const envConfig = join(testDir, "env-config.yaml");
      const explicitConfig = join(testDir, "explicit-config.yaml");

      writeFileSync(envConfig, "port: 3001\nprojects: {}");
      writeFileSync(explicitConfig, "port: 3002\nprojects: {}");

      process.env["AO_CONFIG_PATH"] = envConfig;

      const config = loadConfig(explicitConfig);
      expect(config.port).toBe(3002); // Should use explicit, not env
    });

    it("should use env var over default search", () => {
      const envConfig = join(testDir, "env-config.yaml");
      const localConfig = join(testDir, "agent-orchestrator.yaml");

      writeFileSync(envConfig, "port: 3001\nprojects: {}");
      writeFileSync(localConfig, "port: 3002\nprojects: {}");

      process.env["AO_CONFIG_PATH"] = envConfig;

      const config = loadConfig();
      expect(config.port).toBe(3001); // Should use env, not local
    });
  });
});
