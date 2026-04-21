import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasRecentCommits } from "../git-activity.js";

describe("hasRecentCommits", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "ao-git-activity-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir });
  });

  afterEach(() => {
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns true when a commit exists within the default 60s window", async () => {
    await writeFile(join(repoDir, "a.txt"), "hello");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repoDir });

    expect(await hasRecentCommits(repoDir)).toBe(true);
  });

  it("returns false when no commits have been made", async () => {
    expect(await hasRecentCommits(repoDir)).toBe(false);
  });

  it("returns false when the path is not a git repo", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "ao-git-activity-notrepo-"));
    try {
      expect(await hasRecentCommits(notARepo)).toBe(false);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it("respects a custom window", async () => {
    await writeFile(join(repoDir, "a.txt"), "hello");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    // Backdate the commit well outside any short window.
    execFileSync("git", ["commit", "-q", "-m", "old"], {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    });

    expect(await hasRecentCommits(repoDir, 60)).toBe(false);
  });
});
