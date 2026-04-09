import { describe, expect, it } from "vitest";
import type { OrchestratorConfig, ProjectConfig } from "@composio/ao-core";
import {
  appendStringOption,
  resolveRuntimeOverride,
} from "../../src/lib/runtime-overrides.js";

function makeConfig(runtime?: string): OrchestratorConfig {
  return {
    configPath: "/tmp/agent-orchestrator.yaml",
    port: 3000,
    defaults: {
      runtime: runtime ?? "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: [],
    },
    projects: {},
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  };
}

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "My App",
    repo: "org/my-app",
    path: "/tmp/my-app",
    defaultBranch: "main",
    sessionPrefix: "app",
    ...overrides,
  };
}

describe("appendStringOption", () => {
  it("appends values in order", () => {
    expect(appendStringOption("beta", ["alpha"])).toEqual(["alpha", "beta"]);
  });
});

describe("resolveRuntimeOverride", () => {
  it("falls back to the project runtime and merges nested runtimeConfig objects", () => {
    const config = makeConfig("tmux");
    const project = makeProject({
      runtime: "docker",
      runtimeConfig: {
        image: "ghcr.io/composio/ao:base",
        limits: { memory: "2g" },
        network: "bridge",
      },
    });

    const override = resolveRuntimeOverride(config, project, {
      runtimeConfig: JSON.stringify({
        limits: { cpus: "2" },
        tmpfs: ["/tmp"],
      }),
      runtimeMemory: "4g",
      runtimeCapDrop: [" ALL ", ""],
      runtimeTmpfs: [" /cache ", ""],
    });

    expect(override.runtime).toBeUndefined();
    expect(override.effectiveRuntime).toBe("docker");
    expect(override.runtimeConfig).toEqual({
      limits: { cpus: "2", memory: "4g" },
      capDrop: ["ALL"],
      tmpfs: ["/cache"],
    });
    expect(override.effectiveRuntimeConfig).toEqual({
      image: "ghcr.io/composio/ao:base",
      limits: { memory: "4g", cpus: "2" },
      network: "bridge",
      capDrop: ["ALL"],
      tmpfs: ["/cache"],
    });
  });

  it("uses tmux as the implicit default when neither config nor project sets a runtime", () => {
    const config = makeConfig();
    (config.defaults as { runtime?: string }).runtime = undefined;

    const override = resolveRuntimeOverride(config, makeProject(), {});
    expect(override.effectiveRuntime).toBe("tmux");
    expect(override.runtimeConfig).toBeUndefined();
    expect(override.effectiveRuntimeConfig).toBeUndefined();
  });

  it("applies explicit runtime and trims docker flag values", () => {
    const override = resolveRuntimeOverride(makeConfig("process"), makeProject(), {
      runtime: " docker ",
      runtimeImage: " ghcr.io/composio/ao:test ",
      runtimeNetwork: " host ",
      runtimeCpus: " 2 ",
      runtimeGpus: " all ",
      runtimeReadOnly: true,
      runtimeCapDrop: [" SYS_ADMIN ", " "],
      runtimeTmpfs: [" /tmp ", ""],
    });

    expect(override.runtime).toBe("docker");
    expect(override.effectiveRuntime).toBe("docker");
    expect(override.runtimeConfig).toEqual({
      image: "ghcr.io/composio/ao:test",
      network: "host",
      readOnlyRoot: true,
      capDrop: ["SYS_ADMIN"],
      tmpfs: ["/tmp"],
      limits: { cpus: "2", gpus: "all" },
    });
  });

  it("rejects invalid JSON runtime-config values", () => {
    expect(() =>
      resolveRuntimeOverride(makeConfig(), makeProject(), {
        runtimeConfig: "{not-json}",
      }),
    ).toThrow("Invalid --runtime-config JSON");
  });

  it("rejects non-object JSON runtime-config values", () => {
    expect(() =>
      resolveRuntimeOverride(makeConfig(), makeProject(), {
        runtimeConfig: JSON.stringify(["not", "an", "object"]),
      }),
    ).toThrow("--runtime-config must be a JSON object.");
  });
});
