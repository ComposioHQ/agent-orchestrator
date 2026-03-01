/**
 * Unit tests for hash-based path utilities.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  realpathSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateConfigHash,
  generateProjectId,
  generateInstanceId,
  generateSessionPrefix,
  getProjectBaseDir,
  getSessionsDir,
  getWorktreesDir,
  getArchiveDir,
  getLogsDir,
  getRetrospectivesDir,
  getOriginFilePath,
  generateSessionName,
  generateTmuxName,
  parseTmuxName,
  expandHome,
  validateAndStoreOrigin,
  resolveProjectLogDir,
  resolveProjectRetroDir,
} from "../paths.js";
import type { OrchestratorConfig, ProjectConfig } from "../types.js";

describe("Hash Generation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "paths-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("produces 12-character hex string", () => {
    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "projects: {}");

    const hash = generateConfigHash(configPath);

    expect(hash).toHaveLength(12);
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });

  it("is deterministic - same path produces same hash", () => {
    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "projects: {}");

    const hash1 = generateConfigHash(configPath);
    const hash2 = generateConfigHash(configPath);

    expect(hash1).toBe(hash2);
  });

  it("different paths produce different hashes", () => {
    const dir1 = join(tmpDir, "config1");
    const dir2 = join(tmpDir, "config2");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });

    const config1 = join(dir1, "agent-orchestrator.yaml");
    const config2 = join(dir2, "agent-orchestrator.yaml");
    writeFileSync(config1, "projects: {}");
    writeFileSync(config2, "projects: {}");

    const hash1 = generateConfigHash(config1);
    const hash2 = generateConfigHash(config2);

    expect(hash1).not.toBe(hash2);
  });

  it("resolves symlinks before hashing", () => {
    const realDir = join(tmpDir, "real");
    const symlinkDir = join(tmpDir, "symlink");
    mkdirSync(realDir, { recursive: true });

    const realConfig = join(realDir, "agent-orchestrator.yaml");
    writeFileSync(realConfig, "projects: {}");

    // Create symlink to directory
    symlinkSync(realDir, symlinkDir);
    const symlinkConfig = join(symlinkDir, "agent-orchestrator.yaml");

    const hashReal = generateConfigHash(realConfig);
    const hashSymlink = generateConfigHash(symlinkConfig);

    expect(hashSymlink).toBe(hashReal);
  });
});

describe("Project ID Generation", () => {
  it("extracts basename correctly", () => {
    expect(generateProjectId("/Users/alice/repos/integrator")).toBe("integrator");
    expect(generateProjectId("/home/bob/my-app")).toBe("my-app");
    expect(generateProjectId("~/repos/backend")).toBe("backend");
  });

  it("handles paths with trailing slashes", () => {
    expect(generateProjectId("/Users/alice/repos/integrator/")).toBe("integrator");
  });

  it("handles relative paths", () => {
    expect(generateProjectId("./my-project")).toBe("my-project");
    expect(generateProjectId("../other-project")).toBe("other-project");
  });

  it("handles paths with special characters", () => {
    expect(generateProjectId("/repos/my-app_v2")).toBe("my-app_v2");
    expect(generateProjectId("/repos/app-123")).toBe("app-123");
  });
});

describe("Instance ID Generation", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "instance-test-"));
    configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "projects: {}");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("combines hash and project ID correctly", () => {
    const instanceId = generateInstanceId(configPath, "/repos/integrator");

    expect(instanceId).toMatch(/^[a-f0-9]{12}-integrator$/);
  });

  it("same config + same project = same instance ID", () => {
    const id1 = generateInstanceId(configPath, "/repos/integrator");
    const id2 = generateInstanceId(configPath, "/repos/integrator");

    expect(id1).toBe(id2);
  });

  it("same config + different projects = different instance IDs with same hash", () => {
    const id1 = generateInstanceId(configPath, "/repos/integrator");
    const id2 = generateInstanceId(configPath, "/repos/backend");

    // Extract hash prefix
    const hash1 = id1.split("-")[0];
    const hash2 = id2.split("-")[0];

    expect(hash1).toBe(hash2); // Same hash
    expect(id1).not.toBe(id2); // Different instance IDs
    expect(id1).toContain("integrator");
    expect(id2).toContain("backend");
  });

  it("different config + same project = different instance IDs", () => {
    const otherDir = join(tmpdir(), "other-config-test");
    mkdirSync(otherDir, { recursive: true });
    const config2Path = join(otherDir, "agent-orchestrator.yaml");
    writeFileSync(config2Path, "projects: {}");

    const id1 = generateInstanceId(configPath, "/repos/integrator");
    const id2 = generateInstanceId(config2Path, "/repos/integrator");

    expect(id1).not.toBe(id2);

    rmSync(otherDir, { recursive: true, force: true });
  });
});

describe("Session Prefix Generation", () => {
  describe("short names (≤4 chars)", () => {
    it("uses as-is (lowercase)", () => {
      expect(generateSessionPrefix("foo")).toBe("foo");
      expect(generateSessionPrefix("app")).toBe("app");
      expect(generateSessionPrefix("DEMO")).toBe("demo");
      expect(generateSessionPrefix("Api")).toBe("api");
    });
  });

  describe("CamelCase", () => {
    it("extracts uppercase letters", () => {
      expect(generateSessionPrefix("PyTorch")).toBe("pt");
      expect(generateSessionPrefix("TypeScript")).toBe("ts");
      expect(generateSessionPrefix("NextJS")).toBe("njs"); // All uppercase: N, J, S
    });

    it("single uppercase falls through to first-3-chars rule", () => {
      expect(generateSessionPrefix("Integrator")).toBe("int");
      expect(generateSessionPrefix("Project")).toBe("pro");
    });
  });

  describe("kebab-case", () => {
    it("uses initials", () => {
      expect(generateSessionPrefix("agent-orchestrator")).toBe("ao");
      expect(generateSessionPrefix("my-app")).toBe("ma");
      expect(generateSessionPrefix("safe-split")).toBe("ss");
    });
  });

  describe("snake_case", () => {
    it("uses initials", () => {
      expect(generateSessionPrefix("my_project")).toBe("mp");
      expect(generateSessionPrefix("agent_orchestrator")).toBe("ao");
    });
  });

  describe("single word", () => {
    it("uses first 3 characters", () => {
      expect(generateSessionPrefix("integrator")).toBe("int");
      expect(generateSessionPrefix("backend")).toBe("bac");
      expect(generateSessionPrefix("frontend")).toBe("fro");
    });
  });

  describe("edge cases", () => {
    it("handles single character", () => {
      expect(generateSessionPrefix("a")).toBe("a");
    });

    it("handles numbers", () => {
      expect(generateSessionPrefix("project123")).toBe("pro");
    });

    it("handles mixed separators", () => {
      // Splits on dash first: "my-app_v2" → ["my", "app_v2"] → "ma"
      expect(generateSessionPrefix("my-app_v2")).toBe("ma");
    });
  });
});

describe("Path Construction", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "path-construct-"));
    configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "projects: {}");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getProjectBaseDir returns correct format", () => {
    const baseDir = getProjectBaseDir(configPath, "/repos/integrator");

    expect(baseDir).toMatch(/^.*\/.agent-orchestrator\/[a-f0-9]{12}-integrator$/);
  });

  it("getSessionsDir returns {baseDir}/sessions", () => {
    const sessionsDir = getSessionsDir(configPath, "/repos/integrator");

    expect(sessionsDir).toMatch(/\.agent-orchestrator\/[a-f0-9]{12}-integrator\/sessions$/);
  });

  it("getWorktreesDir returns {baseDir}/worktrees", () => {
    const worktreesDir = getWorktreesDir(configPath, "/repos/integrator");

    expect(worktreesDir).toMatch(/\.agent-orchestrator\/[a-f0-9]{12}-integrator\/worktrees$/);
  });

  it("getArchiveDir returns {baseDir}/sessions/archive", () => {
    const archiveDir = getArchiveDir(configPath, "/repos/integrator");

    expect(archiveDir).toMatch(/\.agent-orchestrator\/[a-f0-9]{12}-integrator\/sessions\/archive$/);
  });

  it("getOriginFilePath returns {baseDir}/.origin", () => {
    const originPath = getOriginFilePath(configPath, "/repos/integrator");

    expect(originPath).toMatch(/\.agent-orchestrator\/[a-f0-9]{12}-integrator\/\.origin$/);
  });

  it("all paths share the same base directory", () => {
    const baseDir = getProjectBaseDir(configPath, "/repos/integrator");
    const sessionsDir = getSessionsDir(configPath, "/repos/integrator");
    const worktreesDir = getWorktreesDir(configPath, "/repos/integrator");
    const archiveDir = getArchiveDir(configPath, "/repos/integrator");

    expect(sessionsDir).toContain(baseDir);
    expect(worktreesDir).toContain(baseDir);
    expect(archiveDir).toContain(baseDir);
  });
});

describe("Home Directory Expansion", () => {
  it("expands ~/ correctly", () => {
    const expanded = expandHome("~/repos/integrator");
    const home = process.env.HOME || process.env.USERPROFILE || "";

    expect(expanded).toBe(join(home, "repos/integrator"));
  });

  it("handles non-home paths unchanged", () => {
    expect(expandHome("/absolute/path")).toBe("/absolute/path");
    expect(expandHome("./relative/path")).toBe("./relative/path");
  });

  it("handles ~ without slash", () => {
    const result = expandHome("~no-slash");
    expect(result).toBe("~no-slash"); // Should not expand
  });
});

describe("Session Naming", () => {
  it("generateSessionName format is {prefix}-{num}", () => {
    expect(generateSessionName("int", 1)).toBe("int-1");
    expect(generateSessionName("ao", 42)).toBe("ao-42");
    expect(generateSessionName("be", 999)).toBe("be-999");
  });

  it("does NOT include hash", () => {
    const name = generateSessionName("int", 1);
    expect(name).not.toMatch(/[a-f0-9]{12}/);
  });
});

describe("Tmux Naming", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tmux-naming-"));
    configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "projects: {}");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generateTmuxName format is {hash}-{prefix}-{num}", () => {
    const tmuxName = generateTmuxName(configPath, "int", 1);

    expect(tmuxName).toMatch(/^[a-f0-9]{12}-int-1$/);
  });

  it("ALWAYS includes hash for global uniqueness", () => {
    const tmuxName = generateTmuxName(configPath, "int", 1);

    expect(tmuxName).toMatch(/^[a-f0-9]{12}-/);
  });

  it("parseTmuxName correctly extracts components", () => {
    const parsed = parseTmuxName("a3b4c5d6e7f8-int-1");

    expect(parsed).toEqual({
      hash: "a3b4c5d6e7f8",
      prefix: "int",
      num: 1,
    });
  });

  it("parseTmuxName handles multi-digit numbers", () => {
    const parsed = parseTmuxName("a3b4c5d6e7f8-be-999");

    expect(parsed).toEqual({
      hash: "a3b4c5d6e7f8",
      prefix: "be",
      num: 999,
    });
  });

  it("parseTmuxName handles prefixes with dashes", () => {
    const parsed = parseTmuxName("a3b4c5d6e7f8-my-app-5");

    expect(parsed).toEqual({
      hash: "a3b4c5d6e7f8",
      prefix: "my-app",
      num: 5,
    });
  });

  it("parseTmuxName returns null for invalid formats", () => {
    expect(parseTmuxName("invalid")).toBeNull();
    expect(parseTmuxName("int-1")).toBeNull(); // No hash
    expect(parseTmuxName("a3b4-int-1")).toBeNull(); // Hash too short
    expect(parseTmuxName("not-a-hash-int-1")).toBeNull(); // Invalid hash chars
  });

  it("user-facing name does NOT include hash", () => {
    const userFacing = generateSessionName("int", 1);
    const tmuxName = generateTmuxName(configPath, "int", 1);

    expect(userFacing).toBe("int-1");
    expect(tmuxName).toMatch(/^[a-f0-9]{12}-int-1$/);
    expect(userFacing).not.toEqual(tmuxName);
  });
});

describe("Origin File Management", () => {
  let tmpDir: string;
  let configPath: string;
  let projectPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "origin-test-"));
    configPath = join(tmpDir, "agent-orchestrator.yaml");
    projectPath = join(tmpDir, "project");
    writeFileSync(configPath, "projects: {}");
    mkdtempSync(projectPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates .origin file on first use", () => {
    validateAndStoreOrigin(configPath, projectPath);

    const originPath = getOriginFilePath(configPath, projectPath);

    expect(existsSync(originPath)).toBe(true);

    const content = readFileSync(originPath, "utf-8").trim();
    const resolvedConfig = realpathSync(configPath);
    expect(content).toBe(resolvedConfig);
  });

  it("second call with same config path succeeds", () => {
    validateAndStoreOrigin(configPath, projectPath);

    expect(() => {
      validateAndStoreOrigin(configPath, projectPath);
    }).not.toThrow();
  });

  it("call with different config path throws hash collision error", () => {
    // First config
    validateAndStoreOrigin(configPath, projectPath);

    // Create second config that would have same hash (simulate collision)
    // This is hard to simulate naturally, so we'll manually edit .origin
    const originPath = getOriginFilePath(configPath, projectPath);
    writeFileSync(originPath, "/fake/other/config/path");

    expect(() => {
      validateAndStoreOrigin(configPath, projectPath);
    }).toThrow(/Hash collision detected/);
  });

  it("error message includes both config paths", () => {
    validateAndStoreOrigin(configPath, projectPath);

    const originPath = getOriginFilePath(configPath, projectPath);
    writeFileSync(originPath, "/fake/other/path");

    try {
      validateAndStoreOrigin(configPath, projectPath);
      expect.fail("Should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("/fake/other/path");
      expect(message).toContain(realpathSync(configPath));
    }
  });

  it("creates parent directory if needed", () => {
    // Remove the auto-created directory
    const baseDir = getProjectBaseDir(configPath, projectPath);

    // Validate and store origin (creates directory)
    validateAndStoreOrigin(configPath, projectPath);

    // After validation, directory should exist
    expect(existsSync(baseDir)).toBe(true);
  });
});

describe("Logs and Retrospectives Directories", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "logs-retro-test-"));
    configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "projects: {}");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getLogsDir returns {baseDir}/logs", () => {
    const logsDir = getLogsDir(configPath, "/repos/integrator");

    expect(logsDir).toMatch(
      /\.agent-orchestrator\/[a-f0-9]{12}-integrator\/logs$/,
    );
  });

  it("getRetrospectivesDir returns {baseDir}/retrospectives", () => {
    const retroDir = getRetrospectivesDir(configPath, "/repos/integrator");

    expect(retroDir).toMatch(
      /\.agent-orchestrator\/[a-f0-9]{12}-integrator\/retrospectives$/,
    );
  });

  it("logs and retrospectives share the same base directory", () => {
    const baseDir = getProjectBaseDir(configPath, "/repos/integrator");
    const logsDir = getLogsDir(configPath, "/repos/integrator");
    const retroDir = getRetrospectivesDir(configPath, "/repos/integrator");

    expect(logsDir).toBe(join(baseDir, "logs"));
    expect(retroDir).toBe(join(baseDir, "retrospectives"));
  });
});

describe("resolveProjectLogDir", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "resolve-log-test-"));
    configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "projects: {}");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no projects are configured", () => {
    const config = {
      configPath,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {},
      notifiers: {},
      notificationRouting: {} as OrchestratorConfig["notificationRouting"],
      reactions: {},
    } satisfies OrchestratorConfig;

    expect(resolveProjectLogDir(config)).toBeNull();
  });

  it("returns logs dir for the first project", () => {
    const project: ProjectConfig = {
      name: "Test",
      repo: "owner/repo",
      path: "/repos/integrator",
      defaultBranch: "main",
      sessionPrefix: "int",
    };
    const config = {
      configPath,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { integrator: project },
      notifiers: {},
      notificationRouting: {} as OrchestratorConfig["notificationRouting"],
      reactions: {},
    } satisfies OrchestratorConfig;

    const result = resolveProjectLogDir(config);

    expect(result).not.toBeNull();
    expect(result).toMatch(/\.agent-orchestrator\/[a-f0-9]{12}-integrator\/logs$/);
  });

  it("uses the first project when multiple are configured", () => {
    const projectA: ProjectConfig = {
      name: "Alpha",
      repo: "owner/alpha",
      path: "/repos/alpha",
      defaultBranch: "main",
      sessionPrefix: "alp",
    };
    const projectB: ProjectConfig = {
      name: "Beta",
      repo: "owner/beta",
      path: "/repos/beta",
      defaultBranch: "main",
      sessionPrefix: "bet",
    };
    const config = {
      configPath,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { alpha: projectA, beta: projectB },
      notifiers: {},
      notificationRouting: {} as OrchestratorConfig["notificationRouting"],
      reactions: {},
    } satisfies OrchestratorConfig;

    const result = resolveProjectLogDir(config);

    // Should resolve to the first project (alpha)
    expect(result).toMatch(/alpha\/logs$/);
  });
});

describe("resolveProjectRetroDir", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "resolve-retro-test-"));
    configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "projects: {}");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no projects are configured", () => {
    const config = {
      configPath,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {},
      notifiers: {},
      notificationRouting: {} as OrchestratorConfig["notificationRouting"],
      reactions: {},
    } satisfies OrchestratorConfig;

    expect(resolveProjectRetroDir(config)).toBeNull();
  });

  it("returns retrospectives dir for the first project", () => {
    const project: ProjectConfig = {
      name: "Test",
      repo: "owner/repo",
      path: "/repos/integrator",
      defaultBranch: "main",
      sessionPrefix: "int",
    };
    const config = {
      configPath,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { integrator: project },
      notifiers: {},
      notificationRouting: {} as OrchestratorConfig["notificationRouting"],
      reactions: {},
    } satisfies OrchestratorConfig;

    const result = resolveProjectRetroDir(config);

    expect(result).not.toBeNull();
    expect(result).toMatch(
      /\.agent-orchestrator\/[a-f0-9]{12}-integrator\/retrospectives$/,
    );
  });
});

describe("Hash Collision Probability", () => {
  it("documents expected collision rate", () => {
    // 12 hex chars = 48 bits of entropy
    // Birthday paradox: 50% collision at sqrt(2^48) ≈ 16.7 million
    // For a single machine with <1000 orchestrator instances: negligible

    const bitsOfEntropy = 48;
    const uniqueValues = Math.pow(2, bitsOfEntropy);
    const sqrt = Math.sqrt(uniqueValues);

    expect(sqrt).toBeGreaterThan(16_000_000);
    expect(sqrt).toBeLessThan(17_000_000);

    // For practical purposes: <0.001% chance with 1000 instances
    const instances = 1000;
    const probability = (instances * (instances - 1)) / (2 * uniqueValues);

    expect(probability).toBeLessThan(0.00001); // Less than 0.001%
  });
});
