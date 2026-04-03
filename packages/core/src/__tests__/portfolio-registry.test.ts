import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  discoverProjects,
  getPortfolio,
  loadGlobalConfig,
  loadPreferences,
  loadRegistered,
  refreshProject,
  registerProject,
  saveGlobalConfig,
  savePreferences,
  saveRegistered,
  unregisterProject,
  updatePreferences,
} from "../index.js";
import { getPreferencesPath, getRegisteredPath } from "../paths.js";

/** Helper to create a minimal valid global config */
function makeGlobalConfig(projects: Record<string, { path: string; [key: string]: unknown }>) {
  return {
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects,
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
  };
}

describe("portfolio-registry", () => {
  let tempRoot: string;
  let previousHome: string | undefined;
  let previousGlobalConfig: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "portfolio-registry-test-"));
    previousHome = process.env.HOME;
    previousGlobalConfig = process.env.AO_GLOBAL_CONFIG;
    process.env.HOME = tempRoot;
    process.env.AO_GLOBAL_CONFIG = join(tempRoot, "global-config.yaml");
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousGlobalConfig === undefined) {
      delete process.env.AO_GLOBAL_CONFIG;
    } else {
      process.env.AO_GLOBAL_CONFIG = previousGlobalConfig;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("projects the portfolio from global config and applies preferences", () => {
    saveGlobalConfig(makeGlobalConfig({
      alpha: {
        name: "Alpha",
        path: "/tmp/alpha",
        repo: "acme/alpha",
        defaultBranch: "main",
        sessionPrefix: "alp",
      },
      beta: {
        name: "Beta",
        path: "/tmp/beta",
        repo: "acme/beta",
        defaultBranch: "develop",
        sessionPrefix: "bet",
      },
    }));

    savePreferences({
      version: 1,
      projectOrder: ["beta", "alpha"],
      projects: {
        beta: { pinned: true, displayName: "Docs" },
        alpha: { enabled: false },
      },
    });

    const portfolio = getPortfolio();

    expect(portfolio.map((project) => project.id)).toEqual(["beta", "alpha"]);
    expect(portfolio[0]).toMatchObject({
      id: "beta",
      name: "Docs",
      source: "config",
      pinned: true,
      enabled: true,
      repoPath: "/tmp/beta",
    });
    expect(portfolio[1]).toMatchObject({
      id: "alpha",
      enabled: false,
      source: "config",
    });
  });

  it("registers and unregisters projects through the global config", () => {
    const repoPath = join(tempRoot, "repos", "demo");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(
      join(repoPath, "agent-orchestrator.yaml"),
      [
        "repo: acme/demo",
        "defaultBranch: main",
        "runtime: tmux",
        "agent: claude-code",
        "workspace: worktree",
      ].join("\n"),
    );

    registerProject(repoPath, "demo");

    const registered = loadGlobalConfig();
    expect(registered?.projects["demo"]).toMatchObject({
      name: "demo",
      path: repoPath,
      repo: "acme/demo",
    });

    unregisterProject("demo");

    const updated = loadGlobalConfig();
    expect(updated?.projects["demo"]).toBeUndefined();
  });

  it("falls back when registered.json has an unexpected shape", () => {
    mkdirSync(dirname(getRegisteredPath()), { recursive: true });
    writeFileSync(
      getRegisteredPath(),
      JSON.stringify({ version: 1, projects: [{ path: 42, addedAt: "nope" }] }),
    );

    expect(loadRegistered()).toEqual({ version: 1, projects: [] });
  });

  it("sanitizes registered project entries instead of returning raw parsed objects", () => {
    mkdirSync(dirname(getRegisteredPath()), { recursive: true });
    writeFileSync(
      getRegisteredPath(),
      JSON.stringify({
        version: 1,
        projects: [
          {
            path: "/tmp/demo",
            addedAt: "2026-04-02T00:00:00.000Z",
            extra: "ignore-me",
          },
        ],
      }),
    );

    expect(loadRegistered()).toEqual({
      version: 1,
      projects: [{ path: "/tmp/demo", addedAt: "2026-04-02T00:00:00.000Z" }],
    });
  });

  it("falls back when preferences.json has an unexpected shape", () => {
    mkdirSync(dirname(getPreferencesPath()), { recursive: true });
    writeFileSync(
      getPreferencesPath(),
      JSON.stringify({
        version: 1,
        defaultProjectId: 123,
        projects: { alpha: { pinned: "yes" } },
      }),
    );

    expect(loadPreferences()).toEqual({ version: 1 });
  });

  // --- parsePortfolioRegistered edge cases ---

  it("returns fallback when registered.json has wrong version", () => {
    mkdirSync(dirname(getRegisteredPath()), { recursive: true });
    writeFileSync(
      getRegisteredPath(),
      JSON.stringify({ version: 2, projects: [] }),
    );

    expect(loadRegistered()).toEqual({ version: 1, projects: [] });
  });

  it("returns fallback when registered.json is not an object", () => {
    mkdirSync(dirname(getRegisteredPath()), { recursive: true });
    writeFileSync(getRegisteredPath(), JSON.stringify("not-an-object"));

    expect(loadRegistered()).toEqual({ version: 1, projects: [] });
  });

  it("returns fallback when registered.json projects is not an array", () => {
    mkdirSync(dirname(getRegisteredPath()), { recursive: true });
    writeFileSync(
      getRegisteredPath(),
      JSON.stringify({ version: 1, projects: "not-array" }),
    );

    expect(loadRegistered()).toEqual({ version: 1, projects: [] });
  });

  it("returns fallback when registered project has non-string configProjectKey", () => {
    mkdirSync(dirname(getRegisteredPath()), { recursive: true });
    writeFileSync(
      getRegisteredPath(),
      JSON.stringify({
        version: 1,
        projects: [
          {
            path: "/tmp/demo",
            addedAt: "2026-04-02T00:00:00.000Z",
            configProjectKey: 42,
          },
        ],
      }),
    );

    expect(loadRegistered()).toEqual({ version: 1, projects: [] });
  });

  it("preserves configProjectKey when it is a valid string", () => {
    mkdirSync(dirname(getRegisteredPath()), { recursive: true });
    writeFileSync(
      getRegisteredPath(),
      JSON.stringify({
        version: 1,
        projects: [
          {
            path: "/tmp/demo",
            addedAt: "2026-04-02T00:00:00.000Z",
            configProjectKey: "my-project",
          },
        ],
      }),
    );

    expect(loadRegistered()).toEqual({
      version: 1,
      projects: [
        {
          path: "/tmp/demo",
          addedAt: "2026-04-02T00:00:00.000Z",
          configProjectKey: "my-project",
        },
      ],
    });
  });

  it("returns fallback when registered.json contains invalid JSON", () => {
    mkdirSync(dirname(getRegisteredPath()), { recursive: true });
    writeFileSync(getRegisteredPath(), "not valid json {{{");

    expect(loadRegistered()).toEqual({ version: 1, projects: [] });
  });

  it("returns default when registered.json does not exist", () => {
    // No file written - exercises line 143
    expect(loadRegistered()).toEqual({ version: 1, projects: [] });
  });

  // --- parsePortfolioPreferences edge cases ---

  it("returns fallback when preferences.json is not an object", () => {
    mkdirSync(dirname(getPreferencesPath()), { recursive: true });
    writeFileSync(getPreferencesPath(), JSON.stringify([1, 2, 3]));

    expect(loadPreferences()).toEqual({ version: 1 });
  });

  it("returns fallback when preferences.json has wrong version", () => {
    mkdirSync(dirname(getPreferencesPath()), { recursive: true });
    writeFileSync(
      getPreferencesPath(),
      JSON.stringify({ version: 99 }),
    );

    expect(loadPreferences()).toEqual({ version: 1 });
  });

  it("returns fallback when projectOrder contains non-strings", () => {
    mkdirSync(dirname(getPreferencesPath()), { recursive: true });
    writeFileSync(
      getPreferencesPath(),
      JSON.stringify({ version: 1, projectOrder: [1, 2] }),
    );

    expect(loadPreferences()).toEqual({ version: 1 });
  });

  it("returns fallback when projects value is not a record", () => {
    mkdirSync(dirname(getPreferencesPath()), { recursive: true });
    writeFileSync(
      getPreferencesPath(),
      JSON.stringify({ version: 1, projects: "bad" }),
    );

    expect(loadPreferences()).toEqual({ version: 1 });
  });

  it("returns fallback when a project preference entry is not a record", () => {
    mkdirSync(dirname(getPreferencesPath()), { recursive: true });
    writeFileSync(
      getPreferencesPath(),
      JSON.stringify({ version: 1, projects: { alpha: "not-a-record" } }),
    );

    expect(loadPreferences()).toEqual({ version: 1 });
  });

  it("returns fallback when project preference has non-boolean pinned", () => {
    mkdirSync(dirname(getPreferencesPath()), { recursive: true });
    writeFileSync(
      getPreferencesPath(),
      JSON.stringify({ version: 1, projects: { alpha: { pinned: "yes" } } }),
    );

    expect(loadPreferences()).toEqual({ version: 1 });
  });

  it("returns fallback when project preference has non-boolean enabled", () => {
    mkdirSync(dirname(getPreferencesPath()), { recursive: true });
    writeFileSync(
      getPreferencesPath(),
      JSON.stringify({ version: 1, projects: { alpha: { enabled: 1 } } }),
    );

    expect(loadPreferences()).toEqual({ version: 1 });
  });

  it("returns fallback when project preference has non-string displayName", () => {
    mkdirSync(dirname(getPreferencesPath()), { recursive: true });
    writeFileSync(
      getPreferencesPath(),
      JSON.stringify({ version: 1, projects: { alpha: { displayName: 42 } } }),
    );

    expect(loadPreferences()).toEqual({ version: 1 });
  });

  it("parses valid preferences with all optional fields", () => {
    mkdirSync(dirname(getPreferencesPath()), { recursive: true });
    writeFileSync(
      getPreferencesPath(),
      JSON.stringify({
        version: 1,
        defaultProjectId: "alpha",
        projectOrder: ["alpha", "beta"],
        projects: {
          alpha: { pinned: true, enabled: false, displayName: "My Alpha" },
        },
      }),
    );

    const prefs = loadPreferences();
    expect(prefs).toEqual({
      version: 1,
      defaultProjectId: "alpha",
      projectOrder: ["alpha", "beta"],
      projects: {
        alpha: { pinned: true, enabled: false, displayName: "My Alpha" },
      },
    });
  });

  it("returns default when preferences.json does not exist", () => {
    // No file written - exercises line 164
    expect(loadPreferences()).toEqual({ version: 1 });
  });

  it("returns default when preferences.json contains invalid JSON", () => {
    mkdirSync(dirname(getPreferencesPath()), { recursive: true });
    writeFileSync(getPreferencesPath(), "{broken json");

    expect(loadPreferences()).toEqual({ version: 1 });
  });

  // --- saveRegistered ---

  it("saves and loads registered projects", () => {
    const data = {
      version: 1 as const,
      projects: [
        { path: "/tmp/project-a", addedAt: "2026-01-01T00:00:00.000Z" },
      ],
    };

    saveRegistered(data);
    expect(loadRegistered()).toEqual(data);
  });

  // --- updatePreferences ---

  it("atomically updates preferences via updater function", () => {
    savePreferences({ version: 1 });

    updatePreferences((prefs) => {
      prefs.defaultProjectId = "beta";
      prefs.projectOrder = ["beta", "alpha"];
    });

    const result = loadPreferences();
    expect(result.defaultProjectId).toBe("beta");
    expect(result.projectOrder).toEqual(["beta", "alpha"]);
  });

  // --- applyPreferences sorting ---

  it("sorts pinned projects before unpinned", () => {
    saveGlobalConfig(makeGlobalConfig({
      alpha: { name: "Alpha", path: "/tmp/alpha" },
      beta: { name: "Beta", path: "/tmp/beta" },
    }));

    savePreferences({
      version: 1,
      projects: {
        beta: { pinned: true },
      },
    });

    const portfolio = getPortfolio();
    expect(portfolio[0].id).toBe("beta");
    expect(portfolio[1].id).toBe("alpha");
  });

  it("sorts by name when order and pinned are equal", () => {
    saveGlobalConfig(makeGlobalConfig({
      zulu: { name: "Zulu", path: "/tmp/zulu" },
      alpha: { name: "Alpha", path: "/tmp/alpha" },
      mike: { name: "Mike", path: "/tmp/mike" },
    }));

    savePreferences({ version: 1 });

    const portfolio = getPortfolio();
    const names = portfolio.map((p) => p.name);
    expect(names).toEqual(["Alpha", "Mike", "Zulu"]);
  });

  it("sorts by custom order from preferences when provided", () => {
    saveGlobalConfig(makeGlobalConfig({
      alpha: { name: "Alpha", path: "/tmp/alpha" },
      beta: { name: "Beta", path: "/tmp/beta" },
      gamma: { name: "Gamma", path: "/tmp/gamma" },
    }));

    savePreferences({
      version: 1,
      projectOrder: ["gamma", "alpha"],
    });

    const portfolio = getPortfolio();
    // gamma (order 0) < alpha (order 1) < beta (no order = Infinity, fallback name)
    expect(portfolio.map((p) => p.id)).toEqual(["gamma", "alpha", "beta"]);
  });

  // --- projectFromGlobalConfig field mapping ---

  it("uses project id as name when name is missing or empty", () => {
    saveGlobalConfig(makeGlobalConfig({
      "my-project": { name: "", path: "/tmp/proj" },
    }));

    const portfolio = getPortfolio();
    expect(portfolio[0].name).toBe("my-project");
  });

  it("maps repo and defaultBranch from global config entries", () => {
    saveGlobalConfig(makeGlobalConfig({
      alpha: {
        name: "Alpha",
        path: "/tmp/alpha",
        repo: "acme/alpha",
        defaultBranch: "develop",
        sessionPrefix: "alp",
      },
    }));

    const portfolio = getPortfolio();
    expect(portfolio[0]).toMatchObject({
      repo: "acme/alpha",
      defaultBranch: "develop",
      sessionPrefix: "alp",
    });
  });

  it("handles missing repo and defaultBranch gracefully", () => {
    saveGlobalConfig(makeGlobalConfig({
      alpha: { name: "Alpha", path: "/tmp/alpha" },
    }));

    const portfolio = getPortfolio();
    expect(portfolio[0].repo).toBeUndefined();
    expect(portfolio[0].defaultBranch).toBeUndefined();
  });

  it("generates sessionPrefix when not provided or empty", () => {
    saveGlobalConfig(makeGlobalConfig({
      alpha: { name: "Alpha", path: "/tmp/alpha", sessionPrefix: "" },
    }));

    const portfolio = getPortfolio();
    // Should have a generated prefix, not empty
    expect(portfolio[0].sessionPrefix).toBeTruthy();
    expect(portfolio[0].sessionPrefix.length).toBeGreaterThan(0);
  });

  // --- discoverProjects ---

  it("discoverProjects returns projects from global config", () => {
    saveGlobalConfig(makeGlobalConfig({
      alpha: { name: "Alpha", path: "/tmp/alpha", repo: "acme/alpha" },
    }));

    const discovered = discoverProjects();
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      id: "alpha",
      name: "Alpha",
      source: "config",
    });
  });

  it("discoverProjects returns empty array when no global config exists", () => {
    const discovered = discoverProjects();
    expect(discovered).toEqual([]);
  });

  // --- getPortfolio fallback to loadConfig ---

  it("falls back to loaded config when global config has no projects", () => {
    // When no global config exists, getPortfolio should try fallbackPortfolioFromLoadedConfig.
    // Since there's no agent-orchestrator.yaml in cwd either, it should return empty.
    const portfolio = getPortfolio();
    expect(portfolio).toEqual([]);
  });

  // --- registerProject error case ---

  it("throws when no local project config found", () => {
    const noConfigPath = join(tempRoot, "no-config-here");
    mkdirSync(noConfigPath, { recursive: true });

    expect(() => registerProject(noConfigPath)).toThrow(
      /No local project config found/,
    );
  });

  it("registers project using displayName when provided", () => {
    const repoPath = join(tempRoot, "repos", "custom");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(
      join(repoPath, "agent-orchestrator.yaml"),
      [
        "repo: acme/custom",
        "defaultBranch: main",
        "runtime: tmux",
        "agent: claude-code",
        "workspace: worktree",
      ].join("\n"),
    );

    registerProject(repoPath, "custom", "Custom Display Name");

    const config = loadGlobalConfig();
    expect(config?.projects["custom"]).toMatchObject({
      name: "Custom Display Name",
    });
  });

  it("uses basename as projectId when configProjectKey is not provided", () => {
    const repoPath = join(tempRoot, "repos", "auto-id");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(
      join(repoPath, "agent-orchestrator.yaml"),
      [
        "repo: acme/auto-id",
        "defaultBranch: main",
        "runtime: tmux",
        "agent: claude-code",
        "workspace: worktree",
      ].join("\n"),
    );

    registerProject(repoPath);

    const config = loadGlobalConfig();
    expect(config?.projects["auto-id"]).toBeDefined();
  });

  // --- unregisterProject edge cases ---

  it("is a no-op when unregistering a project that does not exist", () => {
    saveGlobalConfig(makeGlobalConfig({
      alpha: { name: "Alpha", path: "/tmp/alpha" },
    }));

    unregisterProject("nonexistent");

    const config = loadGlobalConfig();
    expect(config?.projects["alpha"]).toBeDefined();
  });

  it("is a no-op when unregistering with no global config", () => {
    // No global config file exists
    expect(() => unregisterProject("anything")).not.toThrow();
  });

  it("removes project from projectOrder when unregistering", () => {
    const config = makeGlobalConfig({
      alpha: { name: "Alpha", path: "/tmp/alpha" },
      beta: { name: "Beta", path: "/tmp/beta" },
    });
    (config as Record<string, unknown>).projectOrder = ["alpha", "beta"];
    saveGlobalConfig(config as Parameters<typeof saveGlobalConfig>[0]);

    unregisterProject("alpha");

    const updated = loadGlobalConfig();
    expect(updated?.projects["alpha"]).toBeUndefined();
    expect((updated as Record<string, unknown>).projectOrder).toEqual(["beta"]);
  });

  it("removes projectOrder entirely when last entry is removed", () => {
    const config = makeGlobalConfig({
      alpha: { name: "Alpha", path: "/tmp/alpha" },
    });
    (config as Record<string, unknown>).projectOrder = ["alpha"];
    saveGlobalConfig(config as Parameters<typeof saveGlobalConfig>[0]);

    unregisterProject("alpha");

    const updated = loadGlobalConfig();
    expect((updated as Record<string, unknown>).projectOrder).toBeUndefined();
  });

  // --- refreshProject ---

  it("refreshProject is a no-op that does not throw", () => {
    expect(() => refreshProject("any-id", "/any/path")).not.toThrow();
  });

  // --- applyPreferences with non-existent project id ---

  it("ignores preference entries for projects not in the portfolio", () => {
    saveGlobalConfig(makeGlobalConfig({
      alpha: { name: "Alpha", path: "/tmp/alpha" },
    }));

    savePreferences({
      version: 1,
      projects: {
        nonexistent: { pinned: true, displayName: "Ghost" },
      },
    });

    const portfolio = getPortfolio();
    expect(portfolio).toHaveLength(1);
    expect(portfolio[0].id).toBe("alpha");
    expect(portfolio[0].pinned).toBe(false);
  });
});
