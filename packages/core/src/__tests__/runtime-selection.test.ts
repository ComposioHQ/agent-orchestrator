import { describe, expect, it } from "vitest";
import type { ProjectConfig, RuntimeHandle } from "../types.js";
import {
  isPlainObject,
  mergeRuntimeConfig,
  parseStoredRuntimeConfig,
  parseStoredRuntimeHandle,
  resolveRuntimeConfigForSession,
  resolveRuntimeConfigForSpawn,
  resolveRuntimeName,
} from "../runtime-selection.js";

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

describe("runtime-selection helpers", () => {
  it("recognizes plain objects", () => {
    expect(isPlainObject({ ok: true })).toBe(true);
    expect(isPlainObject(["not", "plain"])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
  });

  it("deep-merges nested runtime config without mutating shared objects", () => {
    const base = {
      image: "ghcr.io/composio/ao:base",
      limits: { memory: "2g" },
    };
    const merged = mergeRuntimeConfig(base, {
      limits: { cpus: "2" },
      tmpfs: ["/tmp"],
    });

    expect(merged).toEqual({
      image: "ghcr.io/composio/ao:base",
      limits: { memory: "2g", cpus: "2" },
      tmpfs: ["/tmp"],
    });
    expect(base).toEqual({
      image: "ghcr.io/composio/ao:base",
      limits: { memory: "2g" },
    });
  });

  it("parses stored runtime handle and config from metadata", () => {
    const runtimeHandle = parseStoredRuntimeHandle({
      runtimeHandle: JSON.stringify({
        id: "container-1",
        runtimeName: "docker",
        data: { tmuxSessionName: "tmux-1" },
      } satisfies RuntimeHandle),
    });
    const runtimeConfig = parseStoredRuntimeConfig({
      runtimeConfig: JSON.stringify({
        image: "ghcr.io/composio/ao:test",
        limits: { memory: "4g" },
      }),
    });

    expect(runtimeHandle).toEqual({
      id: "container-1",
      runtimeName: "docker",
      data: { tmuxSessionName: "tmux-1" },
    });
    expect(runtimeConfig).toEqual({
      image: "ghcr.io/composio/ao:test",
      limits: { memory: "4g" },
    });
  });

  it("ignores invalid stored runtime config values", () => {
    expect(parseStoredRuntimeHandle({ runtimeHandle: "{not-json}" })).toBeNull();
    expect(parseStoredRuntimeConfig({ runtimeConfig: JSON.stringify(["bad"]) })).toBeUndefined();
  });

  it("prefers explicit override, then stored handle, then stored runtime, then project default", () => {
    const project = makeProject({ runtime: "docker" });

    expect(
      resolveRuntimeName(project, "tmux", {
        runtimeOverride: "process",
        raw: { runtimeHandle: JSON.stringify({ id: "c1", runtimeName: "docker", data: {} }) },
      }),
    ).toBe("process");

    expect(
      resolveRuntimeName(project, "tmux", {
        raw: { runtimeHandle: JSON.stringify({ id: "c1", runtimeName: "docker", data: {} }) },
      }),
    ).toBe("docker");

    expect(resolveRuntimeName(project, "tmux", { raw: { runtime: "process" } })).toBe("process");
    expect(resolveRuntimeName(project, "tmux")).toBe("docker");
    expect(resolveRuntimeName(makeProject(), "tmux")).toBe("tmux");
  });

  it("merges runtime config for spawn and session restore", () => {
    const project = makeProject({
      runtimeConfig: {
        image: "ghcr.io/composio/ao:base",
        limits: { memory: "2g" },
      },
    });

    expect(
      resolveRuntimeConfigForSpawn(project, {
        limits: { cpus: "2" },
        network: "bridge",
      }),
    ).toEqual({
      image: "ghcr.io/composio/ao:base",
      limits: { memory: "2g", cpus: "2" },
      network: "bridge",
    });

    expect(
      resolveRuntimeConfigForSession(project, {
        runtimeConfig: JSON.stringify({
          image: "ghcr.io/composio/ao:stored",
          limits: { memory: "4g" },
        }),
      }),
    ).toEqual({
      image: "ghcr.io/composio/ao:stored",
      limits: { memory: "4g" },
    });

    expect(resolveRuntimeConfigForSession(project, {})).toEqual({
      image: "ghcr.io/composio/ao:base",
      limits: { memory: "2g" },
    });
  });
});
