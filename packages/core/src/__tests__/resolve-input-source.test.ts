import { describe, it, expect } from "vitest";
import { resolveInputSource } from "../resolve-input-source.js";
import type { ProjectConfig } from "../types.js";

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "test-project",
    repo: "org/test",
    path: "/repos/test",
    defaultBranch: "main",
    sessionPrefix: "test",
    ...overrides,
  };
}

describe("resolveInputSource", () => {
  it("returns null config + linear name when no config", () => {
    const result = resolveInputSource(makeProject(), null);
    expect(result.name).toBe("linear");
    expect(result.config).toBeNull();
  });

  it("uses explicit source name", () => {
    const result = resolveInputSource(makeProject(), "github");
    expect(result.name).toBe("github");
  });

  it("uses project defaultInputSource", () => {
    const project = makeProject({ defaultInputSource: "notion" });
    const result = resolveInputSource(project, null);
    expect(result.name).toBe("notion");
  });

  it("explicit source overrides defaultInputSource", () => {
    const project = makeProject({ defaultInputSource: "notion" });
    const result = resolveInputSource(project, "github");
    expect(result.name).toBe("github");
  });

  it("returns config when inputSources is configured", () => {
    const project = makeProject({
      inputSources: {
        linear: { type: "linear", token: "test-token" },
      },
    });
    const result = resolveInputSource(project, "linear");
    expect(result.config).toEqual({ type: "linear", token: "test-token" });
  });

  it("returns null config for unconfigured source", () => {
    const project = makeProject({
      inputSources: {
        linear: { type: "linear", token: "test-token" },
      },
    });
    const result = resolveInputSource(project, "github");
    expect(result.config).toBeNull();
  });
});
