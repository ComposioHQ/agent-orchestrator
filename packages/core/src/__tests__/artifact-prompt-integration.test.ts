import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { buildPrompt } from "../prompt-builder.js";
import type { ProjectConfig } from "../types.js";

let tmpDir: string;
let project: ProjectConfig;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-artifact-prompt-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  project = {
    name: "Test App",
    repo: "org/test-app",
    path: tmpDir,
    defaultBranch: "main",
    sessionPrefix: "test",
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildPrompt with artifactContext", () => {
  it("includes artifact layer when artifactContext is provided", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      artifactContext: {
        artifactsDir: "/tmp/artifacts",
        totalArtifacts: 5,
        totalSessions: 2,
      },
    });
    expect(result).toContain("## Artifacts");
    expect(result).toContain("ao artifact publish");
    expect(result).toContain("5 artifacts from 2 sessions");
  });

  it("omits artifact layer when artifactContext is undefined", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
    });
    expect(result).not.toContain("## Artifacts");
  });

  it("places artifact layer after base prompt and config context", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      artifactContext: {
        artifactsDir: "/tmp/artifacts",
        totalArtifacts: 0,
        totalSessions: 0,
      },
    });
    const baseIdx = result.indexOf("## Project Context");
    const artifactIdx = result.indexOf("## Artifacts");
    expect(baseIdx).toBeLessThan(artifactIdx);
  });

  it("places artifact layer before user prompt", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      userPrompt: "Focus on backend only.",
      artifactContext: {
        artifactsDir: "/tmp/artifacts",
        totalArtifacts: 0,
        totalSessions: 0,
      },
    });
    const artifactIdx = result.indexOf("## Artifacts");
    const userIdx = result.indexOf("## Additional Instructions");
    expect(artifactIdx).toBeLessThan(userIdx);
  });
});
