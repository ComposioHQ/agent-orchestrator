import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  getPortfolio,
  loadGlobalConfig,
  loadPreferences,
  loadRegistered,
  registerProject,
  saveGlobalConfig,
  savePreferences,
  unregisterProject,
} from "../index.js";
import { getPreferencesPath, getRegisteredPath } from "../paths.js";

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
    saveGlobalConfig({
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: ["desktop"],
      },
      projects: {
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
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    });

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
});
