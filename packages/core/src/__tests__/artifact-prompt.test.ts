import { describe, it, expect } from "vitest";
import {
  buildArtifactLayer,
  buildOrchestratorArtifactSection,
  type ArtifactContext,
} from "../artifact-prompt.js";

describe("buildArtifactLayer", () => {
  it("includes artifact heading and publish commands", () => {
    const ctx: ArtifactContext = {
      artifactsDir: "/tmp/artifacts",
      totalArtifacts: 0,
    };
    const result = buildArtifactLayer(ctx);
    expect(result).toContain("## Artifacts");
    expect(result).toContain("ao artifact publish");
    expect(result).toContain("ao artifact publish");
  });

  it("includes discovery commands", () => {
    const ctx: ArtifactContext = {
      artifactsDir: "/tmp/artifacts",
      totalArtifacts: 0,
    };
    const result = buildArtifactLayer(ctx);
    expect(result).toContain("ao artifact list");
    expect(result).toContain("ao artifact grep");
    expect(result).toContain("ao artifact read");
  });

  it("includes what-to-publish guidance", () => {
    const ctx: ArtifactContext = {
      artifactsDir: "/tmp/artifacts",
      totalArtifacts: 0,
    };
    const result = buildArtifactLayer(ctx);
    expect(result).toContain("### What to Publish");
    expect(result).toContain("Design docs");
    expect(result).toContain("Test reports");
  });

  it("omits artifact summary when totalArtifacts is 0", () => {
    const ctx: ArtifactContext = {
      artifactsDir: "/tmp/artifacts",
      totalArtifacts: 0,
    };
    const result = buildArtifactLayer(ctx);
    expect(result).not.toContain("There are currently");
  });

  it("includes artifact summary when totalArtifacts > 0", () => {
    const ctx: ArtifactContext = {
      artifactsDir: "/tmp/artifacts",
      totalArtifacts: 5,
    };
    const result = buildArtifactLayer(ctx);
    expect(result).toContain("There are currently 5 artifacts");
    expect(result).toContain("ao artifact list");
  });

  it("uses singular 'artifact' when totalArtifacts is 1", () => {
    const ctx: ArtifactContext = {
      artifactsDir: "/tmp/artifacts",
      totalArtifacts: 1,
    };
    const result = buildArtifactLayer(ctx);
    expect(result).toContain("1 artifact.");
    expect(result).not.toContain("1 artifacts");
  });

  it("uses plural 'artifacts' when totalArtifacts > 1", () => {
    const ctx: ArtifactContext = {
      artifactsDir: "/tmp/artifacts",
      totalArtifacts: 10,
    };
    const result = buildArtifactLayer(ctx);
    expect(result).toContain("10 artifacts");
  });
});

describe("buildOrchestratorArtifactSection", () => {
  it("returns orchestrator-specific artifact guidance", () => {
    const result = buildOrchestratorArtifactSection();
    expect(result).toContain("## Session Artifacts");
    expect(result).toContain("ao artifact list");
    expect(result).toContain("ao artifact grep");
    expect(result).toContain("ao artifact read");
    expect(result).toContain("ao artifact summary");
    expect(result).toContain("ao artifact stats");
  });

  it("mentions agents publish outputs", () => {
    const result = buildOrchestratorArtifactSection();
    expect(result).toContain("Agents publish their outputs as artifacts");
  });
});
