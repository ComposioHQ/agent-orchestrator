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
  });
});