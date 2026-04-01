import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionsDir } from "../paths.js";
import {
  getPortfolioSessionCounts,
  listPortfolioSessions,
} from "../portfolio-session-service.js";
import type { PortfolioProject } from "../types.js";

function makeProject(tempRoot: string, id: string, overrides?: Partial<PortfolioProject>): PortfolioProject {
  return {
    id,
    name: id,
    configPath: join(tempRoot, "global.yaml"),
    configProjectKey: id,
    repoPath: join(tempRoot, id),
    repo: `acme/${id}`,
    defaultBranch: "main",
    sessionPrefix: id.slice(0, 3),
    source: "config",
    enabled: true,
    pinned: false,
    degraded: false,
    lastSeenAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("portfolio-session-service", () => {
  it("lists valid portfolio sessions and ignores hidden, archive, and invalid entries", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "portfolio-sessions-"));
    try {
      const project = makeProject(tempRoot, "alpha");
      mkdirSync(project.repoPath, { recursive: true });
      const sessionsDir = getSessionsDir(project.configPath, project.repoPath);
      mkdirSync(join(sessionsDir, ".hidden"), { recursive: true });
      mkdirSync(join(sessionsDir, "archive"), { recursive: true });
      mkdirSync(join(sessionsDir, "not-a-file"), { recursive: true });
      mkdirSync(sessionsDir, { recursive: true });

      writeFileSync(
        join(sessionsDir, "alp-1"),
        [
          "status=working",
          "branch=feat/demo",
          "issue=INT-1",
          "pr=https://github.com/acme/alpha/pull/1",
          "summary=Busy",
          "runtimeHandle=alpha-tmux",
          "createdAt=2026-04-01T00:00:00.000Z",
          "restoredAt=2026-04-02T00:00:00.000Z",
        ].join("\n"),
      );
      writeFileSync(join(sessionsDir, "bad name"), "status=working");
      writeFileSync(join(sessionsDir, ".ignored"), "status=working");

      const sessions = await listPortfolioSessions([project]);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.session).toMatchObject({
        id: "alp-1",
        projectId: "alpha",
        branch: "feat/demo",
        issueId: "INT-1",
        pr: { url: "https://github.com/acme/alpha/pull/1" },
        runtimeHandle: { id: "alpha-tmux" },
        agentInfo: { summary: "Busy" },
      });
      expect(sessions[0]?.session.lastActivityAt.toISOString()).toBe("2026-04-02T00:00:00.000Z");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips disabled or degraded projects and counts active vs terminal sessions", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "portfolio-counts-"));
    try {
      const activeProject = makeProject(tempRoot, "alpha");
      const disabledProject = makeProject(tempRoot, "beta", { enabled: false });
      const degradedProject = makeProject(tempRoot, "gamma", { degraded: true });

      mkdirSync(activeProject.repoPath, { recursive: true });
      const sessionsDir = getSessionsDir(activeProject.configPath, activeProject.repoPath);
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, "alp-1"), "status=working");
      writeFileSync(join(sessionsDir, "alp-2"), "status=merged");

      const sessions = await listPortfolioSessions([activeProject, disabledProject, degradedProject], {
        perProjectTimeoutMs: 50,
      });
      expect(sessions).toHaveLength(2);

      const counts = await getPortfolioSessionCounts([
        activeProject,
        disabledProject,
        degradedProject,
      ]);
      expect(counts["alpha"]).toEqual({ total: 2, active: 1 });
      expect(counts["beta"]).toEqual({ total: 0, active: 0 });
      expect(counts["gamma"]).toEqual({ total: 0, active: 0 });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
