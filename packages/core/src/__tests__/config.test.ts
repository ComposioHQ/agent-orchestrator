import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findConfigFile, loadConfig } from "../config.js";

describe("findConfigFile", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();

  afterEach(() => {
    process.env = originalEnv;
    process.chdir(originalCwd);
  });

  it("returns AO_CONFIG_PATH even when the file has malformed YAML", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "config-test-"));
    try {
      const malformedPath = join(tempRoot, "broken.yaml");
      writeFileSync(malformedPath, "{{invalid yaml::");
      process.env = { ...originalEnv, AO_CONFIG_PATH: malformedPath };

      expect(findConfigFile()).toBe(malformedPath);
      expect(() => loadConfig()).toThrow();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns AO_CONFIG_PATH when it points to a flat local config", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "config-test-"));
    try {
      process.chdir(tempRoot);
      const flatPath = join(tempRoot, "agent-orchestrator.yaml");
      writeFileSync(flatPath, "repo: acme/demo\nagent: codex\n");
      process.env = { ...originalEnv, AO_CONFIG_PATH: flatPath };

      expect(findConfigFile()).toBe(flatPath);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("loads an effective config when AO_CONFIG_PATH points to a flat local config", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "config-test-"));
    try {
      process.chdir(tempRoot);
      const flatPath = join(tempRoot, "agent-orchestrator.yaml");
      const globalDir = join(tempRoot, ".agent-orchestrator");
      const globalPath = join(globalDir, "config.yaml");
      mkdirSync(globalDir, { recursive: true });

      writeFileSync(flatPath, "repo: acme/demo\nagent: codex\nruntime: tmux\n");
      writeFileSync(
        globalPath,
        `projects:\n  demo:\n    name: Demo\n    path: ${tempRoot}\n    sessionPrefix: dm\n`,
      );

      process.env = {
        ...originalEnv,
        AO_CONFIG_PATH: flatPath,
        AO_GLOBAL_CONFIG: globalPath,
      };

      const config = loadConfig();
      expect(config.configPath).toBe(flatPath);
      expect(config.projects.demo).toMatchObject({
        name: "Demo",
        path: tempRoot,
        repo: "acme/demo",
        agent: "codex",
        runtime: "tmux",
        sessionPrefix: "dm",
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("loads degraded project entries from the canonical global config without aborting the whole config", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "config-test-"));
    try {
      const projectDir = join(tempRoot, "broken-project");
      const globalDir = join(tempRoot, ".agent-orchestrator");
      const globalPath = join(globalDir, "config.yaml");
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(globalDir, { recursive: true });

      writeFileSync(join(projectDir, "agent-orchestrator.yaml"), "{{invalid yaml::");
      writeFileSync(
        globalPath,
        [
          "projects:",
          "  demo:",
          `    path: ${projectDir}`,
          "    name: Demo",
          "    sessionPrefix: dm",
          "    repo: acme/demo",
          "    agent: codex",
          "",
        ].join("\n"),
      );

      process.env = {
        ...originalEnv,
        AO_GLOBAL_CONFIG: globalPath,
      };

      const config = loadConfig(globalPath);
      expect(config.projects.demo).toMatchObject({
        name: "Demo",
        path: projectDir,
        sessionPrefix: "dm",
        repo: "acme/demo",
        agent: "codex",
      });
      expect(config.projects.demo?.resolveError).toContain("Failed to parse local config");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
