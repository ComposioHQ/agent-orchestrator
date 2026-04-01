import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCheckpointSummary, writeCheckpoint } from "../checkpoint.js";

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ao-checkpoint-test-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "file.txt"), "hello");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir });
  return dir;
}

describe("checkpoint", () => {
  let repoDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    repoDir = createTempGitRepo();
    sessionsDir = mkdtempSync(join(tmpdir(), "ao-sessions-test-"));
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  describe("writeCheckpoint", () => {
    it("writes valid JSON checkpoint file", async () => {
      await writeCheckpoint("ao-1", sessionsDir, repoDir);

      const checkpointPath = join(sessionsDir, "ao-1.checkpoint");
      expect(existsSync(checkpointPath)).toBe(true);
      const data = JSON.parse(readFileSync(checkpointPath, "utf-8")) as {
        sessionId: string;
        branch: string;
        lastCommitHash: string;
        lastCommitMessage: string;
        hasUncommittedChanges: boolean;
      };
      expect(data.sessionId).toBe("ao-1");
      expect(data.branch).toBe("main");
      expect(data.lastCommitHash).toBeTruthy();
      expect(data.lastCommitMessage).toBe("initial commit");
      expect(data.hasUncommittedChanges).toBe(false);
    });

    it("detects untracked changes", async () => {
      writeFileSync(join(repoDir, "new.txt"), "new file");
      await writeCheckpoint("ao-2", sessionsDir, repoDir);

      const data = JSON.parse(readFileSync(join(sessionsDir, "ao-2.checkpoint"), "utf-8")) as {
        untrackedFiles: string[];
      };
      expect(data.untrackedFiles).toContain("new.txt");
    });

    it("detects staged files", async () => {
      writeFileSync(join(repoDir, "staged.txt"), "staged");
      execFileSync("git", ["add", "staged.txt"], { cwd: repoDir });
      await writeCheckpoint("ao-3", sessionsDir, repoDir);

      const data = JSON.parse(readFileSync(join(sessionsDir, "ao-3.checkpoint"), "utf-8")) as {
        stagedFiles: string[];
        hasUncommittedChanges: boolean;
      };
      expect(data.stagedFiles).toContain("staged.txt");
      expect(data.hasUncommittedChanges).toBe(true);
    });

    it("skips silently when workspace does not exist", async () => {
      await writeCheckpoint("ao-4", sessionsDir, "/nonexistent/path");
      expect(existsSync(join(sessionsDir, "ao-4.checkpoint"))).toBe(false);
    });
  });

  describe("buildCheckpointSummary", () => {
    it("returns markdown summary with git state", async () => {
      const summary = await buildCheckpointSummary("ao-1", sessionsDir, repoDir);
      expect(summary).not.toBeNull();
      expect(summary).toContain("Session Restored After Crash");
      expect(summary).toContain("initial commit");
      expect(summary).toContain("ground truth");
    });

    it("includes saved checkpoint data when available", async () => {
      await writeCheckpoint("ao-5", sessionsDir, repoDir);
      writeFileSync(join(repoDir, "after.txt"), "after crash");

      const summary = await buildCheckpointSummary("ao-5", sessionsDir, repoDir);
      expect(summary).not.toBeNull();
      expect(summary).toContain("Last Checkpoint");
      expect(summary).toContain("initial commit");
    });

    it("handles missing checkpoint gracefully", async () => {
      const summary = await buildCheckpointSummary("ao-6", sessionsDir, repoDir);
      expect(summary).not.toBeNull();
      expect(summary).toContain("No periodic checkpoint found");
    });

    it("returns null when workspace does not exist", async () => {
      const summary = await buildCheckpointSummary("ao-7", sessionsDir, "/nonexistent");
      expect(summary).toBeNull();
    });

    it("handles corrupted checkpoint file", async () => {
      writeFileSync(join(sessionsDir, "ao-8.checkpoint"), "not json{{{");
      const summary = await buildCheckpointSummary("ao-8", sessionsDir, repoDir);
      expect(summary).not.toBeNull();
      expect(summary).toContain("No periodic checkpoint found");
    });

    it("handles checkpoint missing array fields without losing live git summary", async () => {
      writeFileSync(
        join(sessionsDir, "ao-9.checkpoint"),
        JSON.stringify({
          sessionId: "ao-9",
          timestamp: "2026-01-01T00:00:00.000Z",
          lastCommitHash: "deadbeef",
        }),
      );
      const summary = await buildCheckpointSummary("ao-9", sessionsDir, repoDir);
      expect(summary).not.toBeNull();
      expect(summary).toContain("Current Git State");
      expect(summary).toContain("Last Checkpoint");
      expect(summary).toContain("deadbeef");
    });

    it("shows checkpoint age indicator", async () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      writeFileSync(
        join(sessionsDir, "ao-10.checkpoint"),
        JSON.stringify({
          sessionId: "ao-10",
          timestamp: fiveMinutesAgo,
          lastCommitHash: "abc1234",
          lastCommitMessage: "test commit",
          branch: "main",
          stagedFiles: [],
          modifiedFiles: [],
          untrackedFiles: [],
          hasUncommittedChanges: false,
        }),
      );
      const summary = await buildCheckpointSummary("ao-10", sessionsDir, repoDir);
      expect(summary).not.toBeNull();
      expect(summary).toContain("5 minutes ago");
    });

    it("truncates long file lists", async () => {
      const manyFiles = Array.from({ length: 15 }, (_, i) => `file${i}.ts`);
      writeFileSync(
        join(sessionsDir, "ao-11.checkpoint"),
        JSON.stringify({
          sessionId: "ao-11",
          timestamp: new Date().toISOString(),
          lastCommitHash: "def5678",
          lastCommitMessage: "test",
          branch: "main",
          stagedFiles: manyFiles,
          modifiedFiles: [],
          untrackedFiles: [],
          hasUncommittedChanges: true,
        }),
      );
      const summary = await buildCheckpointSummary("ao-11", sessionsDir, repoDir);
      expect(summary).not.toBeNull();
      expect(summary).toContain("... and 5 more");
    });
  });
});
