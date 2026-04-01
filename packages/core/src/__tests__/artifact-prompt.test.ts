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
      totalSessions: 0,
    };
    const result = buildArtifactLayer(ctx);
    expect(result).toContain("## Artifacts");
    expect(result).toContain("ao artifact publish");
    expect(result).toContain("ao artifact publish-ref");
  });

  it("includes discovery commands", () => {
    const ctx: ArtifactContext = {
      artifactsDir: "/tmp/artifacts",
      totalArtifacts: 0,
      totalSessions: 0,
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
      totalSessions: 0,
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
      totalSessions: 0,
    };
    const result = buildArtifactLayer(ctx);
    expect(result).not.toContain("There are currently");
  });

  it("includes artifact summary when totalArtifacts > 0", () => {
    const ctx: ArtifactContext = {
      artifactsDir: "/tmp/artifacts",
      totalArtifacts: 5,
      totalSessions: 2,
    };
    const result = buildArtifactLayer(ctx);
    expect(result).toContain("There are currently 5 artifacts from 2 sessions");
    expect(result).toContain("ao artifact list");
  });

  it("uses singular 'session' when totalSessions is 1", () => {
    const ctx: ArtifactContext = {
      artifactsDir: "/tmp/artifacts",
      totalArtifacts: 3,
      totalSessions: 1,
    };
    const result = buildArtifactLayer(ctx);
    expect(result).toContain("from 1 session.");
    expect(result).not.toContain("from 1 sessions");
  });

  it("uses plural 'sessions' when totalSessions > 1", () => {
    const ctx: ArtifactContext = {
      artifactsDir: "/tmp/artifacts",
      totalArtifacts: 10,
      totalSessions: 3,
    };
    const result = buildArtifactLayer(ctx);
    expect(result).toContain("from 3 sessions");
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
