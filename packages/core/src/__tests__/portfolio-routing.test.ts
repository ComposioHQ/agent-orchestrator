import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PortfolioProject } from "../types.js";
import {
  derivePortfolioProjectId,
  resolvePortfolioProject,
  resolvePortfolioSession,
} from "../portfolio-routing.js";
import { getSessionsDir } from "../paths.js";

describe("portfolio-routing", () => {
  it("resolves projects and derives collision-free project ids", () => {
    const portfolio: PortfolioProject[] = [
      {
        id: "alpha",
        name: "Alpha",
        configPath: "/tmp/global.yaml",
        configProjectKey: "alpha",
        repoPath: "/tmp/alpha",
        defaultBranch: "main",
        sessionPrefix: "alp",
        source: "config",
        enabled: true,
        pinned: false,
        lastSeenAt: new Date().toISOString(),
      },
    ];

    expect(resolvePortfolioProject(portfolio, "alpha")).toBe(portfolio[0]);
    expect(resolvePortfolioProject(portfolio, "missing")).toBeUndefined();
    expect(derivePortfolioProjectId("alpha", new Set(["alpha"]))).toBe("alpha-2");
    expect(derivePortfolioProjectId("alpha", new Set(["alpha", "alpha-2"]))).toBe("alpha-3");
    expect(derivePortfolioProjectId("beta", new Set(["alpha"]))).toBe("beta");
  });

  it("resolves sessions within the selected portfolio project", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "portfolio-routing-"));
    try {
      const project: PortfolioProject = {
        id: "alpha",
        name: "Alpha",
        configPath: join(tempRoot, "global.yaml"),
        configProjectKey: "alpha",
        repoPath: join(tempRoot, "alpha"),
        defaultBranch: "main",
        sessionPrefix: "alp",
        source: "config",
        enabled: true,
        pinned: false,
        lastSeenAt: new Date().toISOString(),
      };
      mkdirSync(project.repoPath, { recursive: true });
      const sessionsDir = getSessionsDir(project.configPath, project.repoPath);
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(
        join(sessionsDir, "alp-1"),
        ["status=working", "branch=feat/demo", "createdAt=2026-04-01T00:00:00.000Z"].join("\n"),
      );

      const resolved = await resolvePortfolioSession([project], "alpha", "alp-1");
      expect(resolved?.session.id).toBe("alp-1");

      const missingProject = await resolvePortfolioSession([project], "missing", "alp-1");
      const missingSession = await resolvePortfolioSession([project], "alpha", "missing");
      expect(missingProject).toBeUndefined();
      expect(missingSession).toBeUndefined();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
