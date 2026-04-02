import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  syncProjectShadow,
} from "../global-config.js";

describe("global-config", () => {
  let tempRoot: string;
  let configPath: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "global-config-test-"));
    configPath = join(tempRoot, "global-config.yaml");
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("preserves sessionPrefix when syncing a flat local project shadow", () => {
    saveGlobalConfig(
      {
        port: 3000,
        readyThresholdMs: 300_000,
        defaults: {
          runtime: "tmux",
          agent: "claude-code",
          workspace: "worktree",
          notifiers: ["desktop"],
        },
        projects: {
          demo: {
            name: "Demo",
            path: "/tmp/demo",
            sessionPrefix: "demo42",
            repo: "acme/demo",
          },
        },
        notifiers: {},
        notificationRouting: { urgent: [], action: [], warning: [], info: [] },
        reactions: {},
      },
      configPath,
    );

    syncProjectShadow(
      "demo",
      {
        repo: "acme/demo",
        defaultBranch: "main",
        agent: "codex",
        runtime: "tmux",
      },
      configPath,
    );

    const globalConfig = loadGlobalConfig(configPath);
    expect(globalConfig?.projects["demo"]).toMatchObject({
      name: "Demo",
      path: "/tmp/demo",
      sessionPrefix: "demo42",
      repo: "acme/demo",
      defaultBranch: "main",
      agent: "codex",
      runtime: "tmux",
    });
  });
});
