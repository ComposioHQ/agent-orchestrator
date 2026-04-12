import { describe, it, expect } from "vitest";
import type { PortfolioProject } from "@aoagents/ao-core";
import {
  formatPortfolioProjectStatus,
  formatPortfolioProjectName,
  formatPortfolioDegradedReason,
} from "../../src/lib/portfolio-display.js";

// Helper to create a minimal PortfolioProject
function makeProject(overrides: Partial<PortfolioProject> = {}): PortfolioProject {
  return {
    id: "test-app",
    name: "Test App",
    configPath: "/tmp/test-app/agent-orchestrator.yaml",
    configProjectKey: "test-app",
    repoPath: "/tmp/test-app",
    sessionPrefix: "test-app",
    source: "discovered" as const,
    enabled: true,
    pinned: false,
    lastSeenAt: new Date().toISOString(),
    degraded: false,
    ...overrides,
  };
}

describe("formatPortfolioProjectStatus", () => {
  it("returns 'degraded' for degraded projects", () => {
    const result = formatPortfolioProjectStatus(
      makeProject({ degraded: true }),
      { total: 0, active: 0 },
    );
    expect(result).toContain("degraded");
  });

  it("returns 'disabled' for non-enabled projects", () => {
    const result = formatPortfolioProjectStatus(
      makeProject({ enabled: false }),
      { total: 0, active: 0 },
    );
    expect(result).toContain("disabled");
  });

  it("returns active count when sessions are active", () => {
    const result = formatPortfolioProjectStatus(
      makeProject(),
      { total: 5, active: 3 },
    );
    expect(result).toContain("3 active");
  });

  it("returns 'idle' when no active sessions", () => {
    const result = formatPortfolioProjectStatus(
      makeProject(),
      { total: 2, active: 0 },
    );
    expect(result).toContain("idle");
  });

  it("returns 'idle' when zero total sessions", () => {
    const result = formatPortfolioProjectStatus(
      makeProject(),
      { total: 0, active: 0 },
    );
    expect(result).toContain("idle");
  });
});

describe("formatPortfolioProjectName", () => {
  it("returns formatted name when name differs from id", () => {
    const result = formatPortfolioProjectName(
      makeProject({ id: "test-app", name: "Test Application" }),
    );
    expect(result).toContain("Test Application");
  });

  it("returns empty string when name equals id", () => {
    const result = formatPortfolioProjectName(
      makeProject({ id: "test-app", name: "test-app" }),
    );
    expect(result).toBe("");
  });
});

describe("formatPortfolioDegradedReason", () => {
  it("returns null when project is not degraded", () => {
    const result = formatPortfolioDegradedReason(makeProject());
    expect(result).toBeNull();
  });

  it("returns null when degraded but no reason", () => {
    const result = formatPortfolioDegradedReason(
      makeProject({ degraded: true }),
    );
    expect(result).toBeNull();
  });

  it("returns reason string when degraded with reason", () => {
    const result = formatPortfolioDegradedReason(
      makeProject({ degraded: true, degradedReason: "Config file missing" }),
    );
    expect(result).toContain("Config file missing");
  });
});
