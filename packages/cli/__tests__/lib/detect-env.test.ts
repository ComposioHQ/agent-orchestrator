import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockGit, mockGh, mockExecSilent, mockDetectDefaultBranch } = vi.hoisted(() => ({
  mockGit: vi.fn(),
  mockGh: vi.fn(),
  mockExecSilent: vi.fn(),
  mockDetectDefaultBranch: vi.fn(),
}));

vi.mock("../../src/lib/shell.js", () => ({
  git: mockGit,
  gh: mockGh,
  execSilent: mockExecSilent,
}));

vi.mock("../../src/lib/git-utils.js", () => ({
  detectDefaultBranch: mockDetectDefaultBranch,
}));

import { detectEnvironment } from "../../src/lib/detect-env.js";

beforeEach(() => {
  mockGit.mockReset();
  mockGh.mockReset();
  mockExecSilent.mockReset();
  mockDetectDefaultBranch.mockReset();
  delete process.env["LINEAR_API_KEY"];
  delete process.env["SLACK_WEBHOOK_URL"];
});

afterEach(() => {
  delete process.env["LINEAR_API_KEY"];
  delete process.env["SLACK_WEBHOOK_URL"];
});

// ---------------------------------------------------------------------------
// detectEnvironment()
// ---------------------------------------------------------------------------

describe("detectEnvironment", () => {
  it("detects a full git repo with all features available", async () => {
    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git";
      if (args[0] === "remote" && args[1] === "get-url") return "git@github.com:owner/repo.git";
      if (args[0] === "branch" && args[1] === "--show-current") return "feature/test";
      return null;
    });
    mockDetectDefaultBranch.mockResolvedValue("main");
    mockExecSilent.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return "tmux 3.3a";
      if (cmd === "gh") return "gh version 2.40";
      return null;
    });
    mockGh.mockResolvedValue("Logged in to github.com");
    process.env["LINEAR_API_KEY"] = "test-key";
    process.env["SLACK_WEBHOOK_URL"] = "https://hooks.slack.com/test";

    const result = await detectEnvironment("/test/dir");

    expect(result).toEqual({
      isGitRepo: true,
      gitRemote: "git@github.com:owner/repo.git",
      ownerRepo: "owner/repo",
      currentBranch: "feature/test",
      defaultBranch: "main",
      hasTmux: true,
      hasGh: true,
      ghAuthed: true,
      hasLinearKey: true,
      hasSlackWebhook: true,
    });
  });

  it("handles non-git directory", async () => {
    mockGit.mockResolvedValue(null);
    mockExecSilent.mockResolvedValue(null);

    const result = await detectEnvironment("/not/a/repo");

    expect(result.isGitRepo).toBe(false);
    expect(result.gitRemote).toBeNull();
    expect(result.ownerRepo).toBeNull();
    expect(result.currentBranch).toBeNull();
    expect(result.defaultBranch).toBeNull();
  });

  it("parses SSH remote URL correctly", async () => {
    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === "rev-parse") return ".git";
      if (args[0] === "remote") return "git@github.com:myorg/my-repo.git";
      if (args[0] === "branch") return "main";
      return null;
    });
    mockDetectDefaultBranch.mockResolvedValue("main");
    mockExecSilent.mockResolvedValue(null);

    const result = await detectEnvironment("/test");

    expect(result.ownerRepo).toBe("myorg/my-repo");
  });

  it("parses HTTPS remote URL correctly", async () => {
    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === "rev-parse") return ".git";
      if (args[0] === "remote") return "https://github.com/owner/repo.git";
      if (args[0] === "branch") return "develop";
      return null;
    });
    mockDetectDefaultBranch.mockResolvedValue("main");
    mockExecSilent.mockResolvedValue(null);

    const result = await detectEnvironment("/test");

    expect(result.ownerRepo).toBe("owner/repo");
  });

  it("handles HTTPS remote URL without .git suffix", async () => {
    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === "rev-parse") return ".git";
      if (args[0] === "remote") return "https://github.com/owner/repo";
      if (args[0] === "branch") return "main";
      return null;
    });
    mockDetectDefaultBranch.mockResolvedValue("main");
    mockExecSilent.mockResolvedValue(null);

    const result = await detectEnvironment("/test");

    expect(result.ownerRepo).toBe("owner/repo");
  });

  it("sets ownerRepo to null when remote is not GitHub", async () => {
    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === "rev-parse") return ".git";
      if (args[0] === "remote") return "git@gitlab.com:org/repo.git";
      if (args[0] === "branch") return "main";
      return null;
    });
    mockDetectDefaultBranch.mockResolvedValue("main");
    mockExecSilent.mockResolvedValue(null);

    const result = await detectEnvironment("/test");

    expect(result.gitRemote).toBe("git@gitlab.com:org/repo.git");
    expect(result.ownerRepo).toBeNull();
  });

  it("detects tmux availability", async () => {
    mockGit.mockResolvedValue(null);
    mockExecSilent.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return "tmux 3.3a";
      return null;
    });

    const result = await detectEnvironment("/test");

    expect(result.hasTmux).toBe(true);
    expect(result.hasGh).toBe(false);
  });

  it("detects gh CLI without auth", async () => {
    mockGit.mockResolvedValue(null);
    mockExecSilent.mockImplementation((cmd: string) => {
      if (cmd === "gh") return "gh version 2.40";
      return null;
    });
    mockGh.mockResolvedValue(null); // auth fails

    const result = await detectEnvironment("/test");

    expect(result.hasGh).toBe(true);
    expect(result.ghAuthed).toBe(false);
  });

  it("does not check gh auth when gh is not installed", async () => {
    mockGit.mockResolvedValue(null);
    mockExecSilent.mockResolvedValue(null);

    const result = await detectEnvironment("/test");

    expect(result.hasGh).toBe(false);
    expect(result.ghAuthed).toBe(false);
    expect(mockGh).not.toHaveBeenCalled();
  });

  it("detects env vars for LINEAR_API_KEY and SLACK_WEBHOOK_URL", async () => {
    mockGit.mockResolvedValue(null);
    mockExecSilent.mockResolvedValue(null);

    process.env["LINEAR_API_KEY"] = "lin_test_123";
    process.env["SLACK_WEBHOOK_URL"] = "https://hooks.slack.com/services/abc";

    const result = await detectEnvironment("/test");

    expect(result.hasLinearKey).toBe(true);
    expect(result.hasSlackWebhook).toBe(true);
  });

  it("reports false for missing env vars", async () => {
    mockGit.mockResolvedValue(null);
    mockExecSilent.mockResolvedValue(null);

    const result = await detectEnvironment("/test");

    expect(result.hasLinearKey).toBe(false);
    expect(result.hasSlackWebhook).toBe(false);
  });

  it("handles git repo with no remote", async () => {
    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === "rev-parse") return ".git";
      if (args[0] === "remote") return null;
      if (args[0] === "branch") return "main";
      return null;
    });
    mockDetectDefaultBranch.mockResolvedValue("main");
    mockExecSilent.mockResolvedValue(null);

    const result = await detectEnvironment("/test");

    expect(result.isGitRepo).toBe(true);
    expect(result.gitRemote).toBeNull();
    expect(result.ownerRepo).toBeNull();
  });

  it("passes workingDir to git calls", async () => {
    mockGit.mockResolvedValue(null);
    mockExecSilent.mockResolvedValue(null);

    await detectEnvironment("/my/project");

    expect(mockGit).toHaveBeenCalledWith(["rev-parse", "--git-dir"], "/my/project");
  });

  it("passes ownerRepo to detectDefaultBranch", async () => {
    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === "rev-parse") return ".git";
      if (args[0] === "remote") return "git@github.com:foo/bar.git";
      if (args[0] === "branch") return "main";
      return null;
    });
    mockDetectDefaultBranch.mockResolvedValue("main");
    mockExecSilent.mockResolvedValue(null);

    await detectEnvironment("/test");

    expect(mockDetectDefaultBranch).toHaveBeenCalledWith("/test", "foo/bar");
  });
});
