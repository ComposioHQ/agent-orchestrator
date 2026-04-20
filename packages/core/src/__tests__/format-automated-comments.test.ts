import { describe, it, expect } from "vitest";
import { formatAutomatedCommentsMessage } from "../format-automated-comments.js";
import type { AutomatedComment, PRInfo } from "../types.js";

function makeComment(overrides: Partial<AutomatedComment> = {}): AutomatedComment {
  return {
    id: "c1",
    botName: "cursor[bot]",
    body: "Potential issue detected",
    path: "src/worker.ts",
    line: 42,
    severity: "warning",
    createdAt: new Date("2026-04-19T00:00:00Z"),
    url: "https://github.com/o/r/pull/9#discussion_r1",
    ...overrides,
  };
}

const prInfo: Pick<PRInfo, "owner" | "repo" | "number"> = {
  owner: "composio",
  repo: "agent-orchestrator",
  number: 1334,
};

describe("formatAutomatedCommentsMessage", () => {
  it("lists each comment with severity, bot, path:line, excerpt and URL", () => {
    const msg = formatAutomatedCommentsMessage([makeComment()]);
    expect(msg).toContain("- **[warning] cursor[bot]** `src/worker.ts:42`: Potential issue detected");
    expect(msg).toContain("  https://github.com/o/r/pull/9#discussion_r1");
  });

  it("interpolates owner/repo/PR number into guidance when PR is provided", () => {
    const msg = formatAutomatedCommentsMessage([makeComment()], prInfo);
    expect(msg).toContain("gh api repos/composio/agent-orchestrator/pulls/1334/reviews --paginate");
    expect(msg).toContain(
      "gh api repos/composio/agent-orchestrator/pulls/1334/reviews/REVIEW_ID/comments",
    );
    expect(msg).toContain("gh api repos/composio/agent-orchestrator/pulls/1334/comments --paginate");
    expect(msg).not.toContain("OWNER/REPO");
    expect(msg).not.toContain("/pulls/PR/");
  });

  it("falls back to OWNER/REPO/PR placeholders when PR is absent", () => {
    const msg = formatAutomatedCommentsMessage([makeComment()]);
    expect(msg).toContain("gh api repos/OWNER/REPO/pulls/PR/reviews --paginate");
    expect(msg).toContain("gh api repos/OWNER/REPO/pulls/PR/reviews/REVIEW_ID/comments");
  });

  it("truncates long first-line excerpts with an ellipsis", () => {
    const long = "x".repeat(400);
    const msg = formatAutomatedCommentsMessage([makeComment({ body: long })]);
    expect(msg).toContain(`${"x".repeat(160)}…`);
    expect(msg).not.toContain("x".repeat(161));
  });

  it("keeps short first lines unmodified (no ellipsis)", () => {
    const msg = formatAutomatedCommentsMessage([makeComment({ body: "short body" })]);
    expect(msg).toContain("short body");
    expect(msg).not.toContain("short body…");
  });

  it("uses only the first line as the excerpt", () => {
    const msg = formatAutomatedCommentsMessage([
      makeComment({ body: "first line\nsecond line with details" }),
    ]);
    expect(msg).toContain("first line");
    expect(msg).not.toContain("second line with details");
  });

  it("omits path:line block when path is missing", () => {
    const msg = formatAutomatedCommentsMessage([makeComment({ path: undefined, line: undefined })]);
    expect(msg).toContain("**[warning] cursor[bot]**: Potential issue detected");
    expect(msg).not.toMatch(/`:\d+`/);
  });

  it("emits path without line when line is missing", () => {
    const msg = formatAutomatedCommentsMessage([makeComment({ line: undefined })]);
    expect(msg).toContain("`src/worker.ts`:");
    expect(msg).not.toContain("src/worker.ts:");
  });

  it("renders each severity tag verbatim", () => {
    const msg = formatAutomatedCommentsMessage([
      makeComment({ id: "a", severity: "error", body: "err body" }),
      makeComment({ id: "b", severity: "warning", body: "warn body" }),
      makeComment({ id: "c", severity: "info", body: "info body" }),
    ]);
    expect(msg).toContain("[error]");
    expect(msg).toContain("[warning]");
    expect(msg).toContain("[info]");
  });

  it("includes the correct-API verification steps and in_reply_to_id hint", () => {
    const msg = formatAutomatedCommentsMessage([makeComment()], prInfo);
    expect(msg).toContain("--paginate");
    expect(msg).toContain("/reviews/REVIEW_ID/comments");
    expect(msg).toContain("in_reply_to_id");
    expect(msg).toContain("submitted_at");
  });

  it("handles multiple comments in order", () => {
    const msg = formatAutomatedCommentsMessage([
      makeComment({ id: "a", body: "first bug" }),
      makeComment({ id: "b", body: "second bug" }),
    ]);
    const firstIdx = msg.indexOf("first bug");
    const secondIdx = msg.indexOf("second bug");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });
});
