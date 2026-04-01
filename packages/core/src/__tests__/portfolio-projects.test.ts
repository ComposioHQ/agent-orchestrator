import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectConfig, clearConfigCache } from "../portfolio-projects.js";
import { saveGlobalConfig } from "../global-config.js";
import type { PortfolioProject } from "../types.js";

describe("portfolio-projects", () => {
  let tempRoot: string;
  let previousHome: string | undefined;
  let previousGlobalConfig: string | undefined;
  let globalConfigPath: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "portfolio-projects-"));
    previousHome = process.env.HOME;
    previousGlobalConfig = process.env.AO_GLOBAL_CONFIG;
    process.env.HOME = tempRoot;
    globalConfigPath = join(tempRoot, "global.yaml");
    process.env.AO_GLOBAL_CONFIG = globalConfigPath;
    clearConfigCache();
  });

  afterEach(() => {
    clearConfigCache();
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

  it("resolves project config from the global registry path", () => {
    const repoPath = join(tempRoot, "repos", "demo");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(
      join(repoPath, "agent-orchestrator.yaml"),
      "repo: acme/demo\nruntime: tmux\nagent: claude-code\nworkspace: worktree\n",
    );

    saveGlobalConfig({
      port: 3002,
      terminalPort: 3100,
      directTerminalPort: 3200,
      readyThresholdMs: 5_000,
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: ["desktop"],
      },
      projects: {
        demo: {
          name: "Demo",
          path: repoPath,
        },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    });

    const entry: PortfolioProject = {
      id: "demo",
      name: "Demo",
      configPath: globalConfigPath,
      configProjectKey: "demo",
      repoPath,
      defaultBranch: "main",
      sessionPrefix: "dem",
      source: "config",
      enabled: true,
      pinned: false,
      lastSeenAt: new Date().toISOString(),
    };

    const resolved = resolveProjectConfig(entry);
    expect(resolved?.config.configPath).toBe(globalConfigPath);
    expect(resolved?.config.port).toBe(3002);
    expect(resolved?.project).toMatchObject({
      name: "Demo",
      path: repoPath,
      repo: "acme/demo",
      runtime: "tmux",
    });
  });

  it("returns null when the global config or target project cannot be resolved", () => {
    const missingEntry: PortfolioProject = {
      id: "missing",
      name: "Missing",
      configPath: globalConfigPath,
      configProjectKey: "missing",
      repoPath: join(tempRoot, "repos", "missing"),
      defaultBranch: "main",
      sessionPrefix: "mis",
      source: "config",
      enabled: true,
      pinned: false,
      lastSeenAt: new Date().toISOString(),
    };

    expect(resolveProjectConfig(missingEntry)).toBeNull();
  });
});
