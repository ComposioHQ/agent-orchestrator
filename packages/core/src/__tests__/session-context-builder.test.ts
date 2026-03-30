import { describe, it, expect } from "vitest";
import {
  buildPreviousSessionContext,
  formatPreviousSessionContext,
  type PreviousSessionContext,
} from "../session-context-builder.js";

describe("buildPreviousSessionContext", () => {
  it("returns null when no useful context is available", async () => {
    const result = await buildPreviousSessionContext(
      "app-1",
      { status: "killed" },
      "/nonexistent/path",
      "main",
    );
    expect(result).toBeNull();
  });

  it("returns context when summary is available", async () => {
    const result = await buildPreviousSessionContext(
      "app-1",
      {
        status: "killed",
        summary: "Implemented login feature",
        branch: "feat/login",
      },
      "/nonexistent/path",
      "main",
    );
    expect(result).not.toBeNull();
    expect(result!.sourceSessionId).toBe("app-1");
    expect(result!.summary).toBe("Implemented login feature");
    expect(result!.previousStatus).toBe("killed");
    expect(result!.branch).toBe("feat/login");
  });

  it("returns context when PR URL is available", async () => {
    const result = await buildPreviousSessionContext(
      "app-2",
      {
        status: "pr_open",
        pr: "https://github.com/org/repo/pull/42",
      },
      "/nonexistent/path",
      "main",
    );
    expect(result).not.toBeNull();
    expect(result!.prUrl).toBe("https://github.com/org/repo/pull/42");
  });

  it("returns null when only status is available (no actionable context)", async () => {
    const result = await buildPreviousSessionContext(
      "app-3",
      { status: "killed" },
      "/nonexistent/path",
      "main",
    );
    expect(result).toBeNull();
  });
});

describe("formatPreviousSessionContext", () => {
  it("formats context with all fields", () => {
    const context: PreviousSessionContext = {
      sourceSessionId: "app-1",
      summary: "Fixed login bug by updating auth middleware",
      previousStatus: "killed",
      prUrl: "https://github.com/org/repo/pull/42",
      branch: "feat/login-fix",
      recentCommits: "abc1234 fix: update auth middleware\ndef5678 chore: add tests",
    };

    const formatted = formatPreviousSessionContext(context);

    expect(formatted).toContain("## Previous Session Context");
    expect(formatted).toContain("`app-1`");
    expect(formatted).toContain("Fixed login bug by updating auth middleware");
    expect(formatted).toContain("`killed`");
    expect(formatted).toContain("https://github.com/org/repo/pull/42");
    expect(formatted).toContain("`feat/login-fix`");
    expect(formatted).toContain("abc1234 fix: update auth middleware");
    expect(formatted).toContain("Continue from where the previous session left off");
  });

  it("formats context with only summary", () => {
    const context: PreviousSessionContext = {
      sourceSessionId: "app-2",
      summary: "Started implementing feature X",
      previousStatus: "working",
      prUrl: null,
      branch: null,
      recentCommits: null,
    };

    const formatted = formatPreviousSessionContext(context);

    expect(formatted).toContain("## Previous Session Context");
    expect(formatted).toContain("Started implementing feature X");
    expect(formatted).not.toContain("### Pull Request");
    expect(formatted).not.toContain("### Branch");
    expect(formatted).not.toContain("### Commits");
  });

  it("includes PR continuation guidance", () => {
    const context: PreviousSessionContext = {
      sourceSessionId: "app-3",
      summary: null,
      previousStatus: "pr_open",
      prUrl: "https://github.com/org/repo/pull/99",
      branch: "feat/stuff",
      recentCommits: null,
    };

    const formatted = formatPreviousSessionContext(context);

    expect(formatted).toContain("Review the existing PR and continue from where it left off");
  });
});
