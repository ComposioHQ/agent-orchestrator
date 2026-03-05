import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 30_000,
  });
  return stdout.trimEnd();
}

describe("branch cleanup integration", () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "ao-cleanup-test-"));
    await git(repoDir, "init", "-b", "main");
    await git(repoDir, "config", "user.email", "test@test.com");
    await git(repoDir, "config", "user.name", "Test");
    await git(repoDir, "commit", "--allow-empty", "-m", "init");
  }, 30_000);

  afterAll(async () => {
    if (repoDir) {
      await rm(repoDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  it("git branch --list finds feat/agent-* branches", async () => {
    await git(repoDir, "branch", "feat/agent-99");
    await git(repoDir, "branch", "feat/agent-100");
    await git(repoDir, "branch", "feat/my-feature");

    const output = await git(
      repoDir,
      "branch",
      "--list",
      "feat/agent-*",
      "--format",
      "%(refname:short)",
    );
    const branches = output
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean);

    expect(branches).toContain("feat/agent-99");
    expect(branches).toContain("feat/agent-100");
    expect(branches).not.toContain("feat/my-feature");
  });

  it("git branch -D deletes a feat/agent-* branch", async () => {
    // Ensure branch exists (created in previous test, but be safe)
    try {
      await git(repoDir, "branch", "feat/agent-deleteme");
    } catch {
      /* already exists */
    }

    const before = await git(repoDir, "branch", "--list", "feat/agent-deleteme");
    expect(before).toContain("feat/agent-deleteme");

    await git(repoDir, "branch", "-D", "feat/agent-deleteme");

    const after = await git(repoDir, "branch", "--list", "feat/agent-deleteme");
    expect(after).not.toContain("feat/agent-deleteme");
  });

  it("does NOT affect non-agent branches during cleanup", async () => {
    // Create some non-agent branches
    try {
      await git(repoDir, "branch", "feat/human-feature");
    } catch {
      /* already exists */
    }
    try {
      await git(repoDir, "branch", "fix/bug-123");
    } catch {
      /* already exists */
    }
    try {
      await git(repoDir, "branch", "feat/agent-cleanup-target");
    } catch {
      /* already exists */
    }

    // List only agent branches
    const agentOutput = await git(
      repoDir,
      "branch",
      "--list",
      "feat/agent-*",
      "--format",
      "%(refname:short)",
    );
    const agentBranches = agentOutput
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean);

    // Delete only agent branches
    for (const branch of agentBranches) {
      await git(repoDir, "branch", "-D", branch);
    }

    const remaining = await git(repoDir, "branch");
    expect(remaining).toContain("feat/human-feature");
    expect(remaining).toContain("fix/bug-123");
    expect(remaining).not.toContain("feat/agent-cleanup-target");
  });

  it("git branch -D on nonexistent branch throws", async () => {
    await expect(
      git(repoDir, "branch", "-D", "feat/agent-nonexistent"),
    ).rejects.toThrow();
  });

  it("handles cleanup when no agent branches exist", async () => {
    // All agent branches should have been deleted by previous tests.
    // Listing should return empty.
    const output = await git(
      repoDir,
      "branch",
      "--list",
      "feat/agent-*",
      "--format",
      "%(refname:short)",
    );
    const branches = output
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean);

    expect(branches).toHaveLength(0);
  });

  it("supports remote-tracking branch deletion with git push --delete", async () => {
    // Set up a bare remote and push to it
    const bareRemote = await mkdtemp(join(tmpdir(), "ao-cleanup-remote-"));
    await git(bareRemote, "init", "--bare");

    await git(repoDir, "remote", "add", "test-origin", bareRemote);
    await git(repoDir, "branch", "feat/agent-remote-test");
    await git(repoDir, "push", "test-origin", "feat/agent-remote-test");

    // Verify the remote branch exists
    const remoteBefore = await git(
      repoDir,
      "ls-remote",
      "--heads",
      "test-origin",
      "feat/agent-remote-test",
    );
    expect(remoteBefore).toContain("feat/agent-remote-test");

    // Delete the remote branch
    await git(
      repoDir,
      "push",
      "test-origin",
      "--delete",
      "feat/agent-remote-test",
    );

    // Verify the remote branch is gone
    const remoteAfter = await git(
      repoDir,
      "ls-remote",
      "--heads",
      "test-origin",
      "feat/agent-remote-test",
    );
    expect(remoteAfter).not.toContain("feat/agent-remote-test");

    // Clean up the local branch and remote
    await git(repoDir, "branch", "-D", "feat/agent-remote-test");
    await git(repoDir, "remote", "remove", "test-origin");
    await rm(bareRemote, { recursive: true, force: true }).catch(() => {});
  });
});
