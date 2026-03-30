import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, findConfigFile } from "../src/config.js";
import { ConfigNotFoundError } from "../src/types.js";

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

    // Clear AO_CONFIG_PATH to ensure test isolation
    delete process.env.AO_CONFIG_PATH;

    // Change to test directory
    process.chdir(testDir);

    // Clear AO_CONFIG_PATH to avoid picking up parent config
    delete process.env["AO_CONFIG_PATH"];
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
      expect(() => loadConfig()).toThrow(ConfigNotFoundError);
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

  describe("Environment Variable Expansion", () => {
    it("should expand ${VAR} references in config", () => {
      const configPath = join(testDir, "agent-orchestrator.yaml");
      writeFileSync(
        configPath,
        `
port: \${TEST_PORT}
projects:
  test-project:
    repo: test/repo
    path: ${testDir}
    defaultBranch: main
`,
      );

      process.env["TEST_PORT"] = "9999";
      const config = loadConfig(configPath);
      expect(config.port).toBe(9999);
    });

    it("should expand ${VAR} in notifier config", () => {
      const configPath = join(testDir, "agent-orchestrator.yaml");
      writeFileSync(
        configPath,
        `
notifiers:
  slack:
    plugin: slack
    webhookUrl: \${SLACK_WEBHOOK_URL}
projects:
  test-project:
    repo: test/repo
    path: ${testDir}
    defaultBranch: main
`,
      );

      process.env["SLACK_WEBHOOK_URL"] = "https://hooks.slack.com/services/ABC/123/XYZ";
      const config = loadConfig(configPath);
      expect(config.notifiers.slack.webhookUrl).toBe(
        "https://hooks.slack.com/services/ABC/123/XYZ",
      );
    });

    it("should leave placeholder unchanged if env var not set", () => {
      const configPath = join(testDir, "agent-orchestrator.yaml");
      writeFileSync(
        configPath,
        `
notifiers:
  slack:
    plugin: slack
    webhookUrl: \${UNDEFINED_VAR}
projects:
  test-project:
    repo: test/repo
    path: ${testDir}
    defaultBranch: main
`,
      );

      // Don't set UNDEFINED_VAR
      const config = loadConfig(configPath);
      expect(config.notifiers.slack.webhookUrl).toBe("${UNDEFINED_VAR}");
    });

    it("should expand multiple env var references", () => {
      const configPath = join(testDir, "agent-orchestrator.yaml");
      writeFileSync(
        configPath,
        `
notifiers:
  slack:
    plugin: slack
    webhookUrl: \${SLACK_WEBHOOK_URL}
  discord:
    plugin: discord
    webhookUrl: \${DISCORD_WEBHOOK_URL}
projects:
  test-project:
    repo: test/repo
    path: \${PROJECT_PATH}
    defaultBranch: main
`,
      );

      process.env["SLACK_WEBHOOK_URL"] = "https://hooks.slack.com/services/ABC/123/XYZ";
      process.env["DISCORD_WEBHOOK_URL"] = "https://discord.com/api/webhooks/123/abc";
      process.env["PROJECT_PATH"] = testDir;

      const config = loadConfig(configPath);
      expect(config.notifiers.slack.webhookUrl).toBe(
        "https://hooks.slack.com/services/ABC/123/XYZ",
      );
      expect(config.notifiers.discord.webhookUrl).toBe(
        "https://discord.com/api/webhooks/123/abc",
      );
      expect(config.projects["test-project"].path).toBe(testDir);
    });

    it("should expand env var with complex value", () => {
      const configPath = join(testDir, "agent-orchestrator.yaml");
      writeFileSync(
        configPath,
        `
notifiers:
  custom:
    plugin: custom
    apiKey: \${API_KEY}
    endpoint: \${API_ENDPOINT}
projects:
  test-project:
    repo: test/repo
    path: ${testDir}
    defaultBranch: main
`,
      );

      process.env["API_KEY"] = "sk-1234567890abcdef";
      process.env["API_ENDPOINT"] = "https://api.example.com/v1/endpoint?param=value";

      const config = loadConfig(configPath);
      expect(config.notifiers.custom.apiKey).toBe("sk-1234567890abcdef");
      expect(config.notifiers.custom.endpoint).toBe(
        "https://api.example.com/v1/endpoint?param=value",
      );
    });
  });
});
