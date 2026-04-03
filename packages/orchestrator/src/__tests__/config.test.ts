import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getDefaultConfig,
  loadConfig,
  loadConfigFile,
  findConfigFile,
  OrchestratorConfigSchema,
  PlannerConfigSchema,
  WorkersConfigSchema,
  ContextConfigSchema,
  GitConfigSchema,
} from "../config.js";

function createTempDir(): string {
  const dir = join(tmpdir(), `ao-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("getDefaultConfig", () => {
  it("returns all defaults", () => {
    const config = getDefaultConfig();
    expect(config.planner.provider).toBe("anthropic");
    expect(config.planner.model).toBe("claude-sonnet-4-20250514");
    expect(config.planner.thinking_effort).toBe("high");
    expect(config.planner.cli).toBe("claude");
    expect(config.planner.max_rounds).toBe(3);
    expect(config.workers.cli).toBe("claude");
    expect(config.workers.timeout_minutes).toBe(30);
    expect(config.workers.max_parallel).toBe(4);
    expect(config.workers.overrides).toEqual({});
    expect(config.context.gather_tree).toBe(true);
    expect(config.context.gather_configs).toBe(true);
    expect(config.context.gather_readme).toBe(true);
    expect(config.context.gather_claude_md).toBe(true);
    expect(config.context.gather_git_log).toBe(true);
    expect(config.context.git_log_count).toBe(20);
    expect(config.context.max_tree_depth).toBe(3);
    expect(config.context.exclude_patterns).toContain("node_modules");
    expect(config.context.exclude_patterns).toContain(".git");
    expect(config.git.worktree_enabled).toBe(true);
    expect(config.git.branch_prefix).toBe("agentpyre/");
    expect(config.git.auto_pr).toBe(false);
  });
});

describe("OrchestratorConfigSchema", () => {
  it("parses empty object with all defaults", () => {
    const config = OrchestratorConfigSchema.parse({});
    expect(config.planner.provider).toBe("anthropic");
    expect(config.workers.max_parallel).toBe(4);
  });

  it("parses partial config and fills defaults", () => {
    const config = OrchestratorConfigSchema.parse({
      planner: { model: "gpt-4o", provider: "openai" },
    });
    expect(config.planner.model).toBe("gpt-4o");
    expect(config.planner.provider).toBe("openai");
    expect(config.planner.cli).toBe("claude"); // default preserved
    expect(config.workers.cli).toBe("claude"); // workers section defaults
  });

  it("rejects max_rounds of 0", () => {
    expect(() =>
      OrchestratorConfigSchema.parse({
        planner: { max_rounds: 0 },
      }),
    ).toThrow();
  });

  it("rejects max_rounds above 10", () => {
    expect(() =>
      OrchestratorConfigSchema.parse({
        planner: { max_rounds: 11 },
      }),
    ).toThrow();
  });

  it("rejects max_parallel of 0", () => {
    expect(() =>
      OrchestratorConfigSchema.parse({
        workers: { max_parallel: 0 },
      }),
    ).toThrow();
  });

  it("rejects negative timeout_minutes", () => {
    expect(() =>
      OrchestratorConfigSchema.parse({
        workers: { timeout_minutes: -5 },
      }),
    ).toThrow();
  });

  it("parses workers.overrides correctly", () => {
    const config = OrchestratorConfigSchema.parse({
      workers: {
        overrides: {
          frontend: { cli: "codex" },
          backend: { cli: "claude" },
        },
      },
    });
    expect(config.workers.overrides.frontend.cli).toBe("codex");
    expect(config.workers.overrides.backend.cli).toBe("claude");
  });

  it("rejects invalid provider", () => {
    expect(() =>
      OrchestratorConfigSchema.parse({
        planner: { provider: "google" },
      }),
    ).toThrow();
  });

  it("rejects invalid thinking_effort", () => {
    expect(() =>
      OrchestratorConfigSchema.parse({
        planner: { thinking_effort: "extreme" },
      }),
    ).toThrow();
  });
});

describe("loadConfigFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses a valid TOML file", () => {
    const filePath = join(tmpDir, "test.toml");
    writeFileSync(
      filePath,
      `[planner]\nmodel = "gpt-4o"\nprovider = "openai"\n`,
    );
    const result = loadConfigFile(filePath);
    expect((result.planner as Record<string, unknown>).model).toBe("gpt-4o");
    expect((result.planner as Record<string, unknown>).provider).toBe("openai");
  });

  it("throws on invalid TOML with file path context", () => {
    const filePath = join(tmpDir, "bad.toml");
    writeFileSync(filePath, "this is not = [valid toml");
    expect(() => loadConfigFile(filePath)).toThrow(/bad\.toml/);
  });
});

describe("findConfigFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds .agentpyre.toml in startDir", () => {
    const configPath = join(tmpDir, ".agentpyre.toml");
    writeFileSync(configPath, "[planner]\n");
    const found = findConfigFile(tmpDir);
    expect(found).toBe(configPath);
  });

  it("finds .agentpyre.toml in parent directory", () => {
    const configPath = join(tmpDir, ".agentpyre.toml");
    writeFileSync(configPath, "[planner]\n");
    const subDir = join(tmpDir, "sub", "deep");
    mkdirSync(subDir, { recursive: true });
    const found = findConfigFile(subDir);
    expect(found).toBe(configPath);
  });

  it("returns null when no config exists", () => {
    // Empty temp dir with no config files, and override home dir check
    const emptyDir = join(tmpDir, "empty");
    mkdirSync(emptyDir, { recursive: true });
    // findConfigFile will walk up from emptyDir and eventually check homedir
    // We can't control homedir, but the project config walk should return null
    // for a temp dir that has no .agentpyre.toml anywhere up the chain
    const found = findConfigFile(emptyDir);
    // If there's a user config at ~/.agentpyre/config.toml, it will be found
    // otherwise null
    expect(found === null || found.includes(".agentpyre")).toBe(true);
  });
});

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns defaults when no config files exist", () => {
    const config = loadConfig(undefined, tmpDir);
    expect(config.planner.provider).toBe("anthropic");
    expect(config.workers.max_parallel).toBe(4);
  });

  it("loads project config and merges with defaults", () => {
    writeFileSync(
      join(tmpDir, ".agentpyre.toml"),
      `[planner]\nmodel = "gpt-4o"\nprovider = "openai"\n\n[workers]\nmax_parallel = 8\n`,
    );
    const config = loadConfig(undefined, tmpDir);
    expect(config.planner.model).toBe("gpt-4o");
    expect(config.planner.provider).toBe("openai");
    expect(config.planner.cli).toBe("claude"); // default preserved
    expect(config.workers.max_parallel).toBe(8);
  });

  it("CLI overrides win over file config", () => {
    writeFileSync(
      join(tmpDir, ".agentpyre.toml"),
      `[planner]\nmodel = "gpt-4o"\nprovider = "openai"\n`,
    );
    const config = loadConfig(
      { planner: { model: "claude-opus-4-20250514", provider: "anthropic", thinking_effort: "high", cli: "claude", max_rounds: 3 } },
      tmpDir,
    );
    expect(config.planner.model).toBe("claude-opus-4-20250514");
    expect(config.planner.provider).toBe("anthropic");
  });

  it("handles context section with custom exclude patterns", () => {
    writeFileSync(
      join(tmpDir, ".agentpyre.toml"),
      `[context]\nexclude_patterns = ["vendor", "tmp"]\nmax_tree_depth = 5\n`,
    );
    const config = loadConfig(undefined, tmpDir);
    expect(config.context.exclude_patterns).toEqual(["vendor", "tmp"]);
    expect(config.context.max_tree_depth).toBe(5);
    expect(config.context.gather_tree).toBe(true); // default preserved
  });

  it("handles git section", () => {
    writeFileSync(
      join(tmpDir, ".agentpyre.toml"),
      `[git]\nbranch_prefix = "feature/"\nauto_pr = true\n`,
    );
    const config = loadConfig(undefined, tmpDir);
    expect(config.git.branch_prefix).toBe("feature/");
    expect(config.git.auto_pr).toBe(true);
    expect(config.git.worktree_enabled).toBe(true); // default
  });
});
