import { describe, it, expect } from "vitest";
import { sessionFromMetadata } from "../utils/session-from-metadata.js";

describe("sessionFromMetadata", () => {
  it("constructs session with minimal metadata", () => {
    const session = sessionFromMetadata("app-1", {});
    expect(session.id).toBe("app-1");
    expect(session.projectId).toBe("");
    expect(session.status).toBe("spawning");
    expect(session.branch).toBeNull();
    expect(session.issueId).toBeNull();
    expect(session.pr).toBeNull();
    expect(session.workspacePath).toBeNull();
    expect(session.runtimeHandle).toBeNull();
    expect(session.agentInfo).toBeNull();
  });

  it("uses options.projectId when meta does not have project (line 22)", () => {
    const session = sessionFromMetadata("app-1", {}, { projectId: "my-app" });
    expect(session.projectId).toBe("my-app");
  });

  it("prefers meta['project'] over options.projectId", () => {
    const session = sessionFromMetadata("app-1", { project: "from-meta" }, { projectId: "from-opts" });
    expect(session.projectId).toBe("from-meta");
  });

  it("uses options.status when provided (line 23)", () => {
    const session = sessionFromMetadata("app-1", { status: "working" }, { status: "killed" });
    expect(session.status).toBe("killed");
  });

  it("parses branch from metadata (line 25)", () => {
    const session = sessionFromMetadata("app-1", { branch: "feat/test" });
    expect(session.branch).toBe("feat/test");
  });

  it("returns null branch when metadata has empty branch string", () => {
    const session = sessionFromMetadata("app-1", { branch: "" });
    expect(session.branch).toBeNull();
  });

  it("parses issueId from metadata", () => {
    const session = sessionFromMetadata("app-1", { issue: "INT-123" });
    expect(session.issueId).toBe("INT-123");
  });

  it("parses PR from GitHub URL in metadata (line 27-40)", () => {
    const session = sessionFromMetadata("app-1", {
      pr: "https://github.com/org/repo/pull/42",
      branch: "feat/test",
    });
    expect(session.pr).not.toBeNull();
    expect(session.pr!.number).toBe(42);
    expect(session.pr!.owner).toBe("org");
    expect(session.pr!.repo).toBe("repo");
    expect(session.pr!.url).toBe("https://github.com/org/repo/pull/42");
    expect(session.pr!.branch).toBe("feat/test");
  });

  it("parses PR with non-GitHub URL (fallback to trailing number)", () => {
    const session = sessionFromMetadata("app-1", {
      pr: "https://gitlab.com/org/repo/-/merge_requests/99",
    });
    expect(session.pr).not.toBeNull();
    expect(session.pr!.number).toBe(99);
    expect(session.pr!.owner).toBe("");
    expect(session.pr!.repo).toBe("");
  });

  it("handles PR URL that cannot be parsed (line 31-36 edge)", () => {
    const session = sessionFromMetadata("app-1", {
      pr: "not-a-valid-url",
    });
    // parsePrFromUrl returns null for URLs without a number — but meta["pr"] is truthy
    // so the IIFE runs, and parsed will be null, so defaults are used
    expect(session.pr).not.toBeNull();
    expect(session.pr!.number).toBe(0);
    expect(session.pr!.owner).toBe("");
    expect(session.pr!.repo).toBe("");
  });

  it("parses workspacePath from metadata", () => {
    const session = sessionFromMetadata("app-1", { worktree: "/tmp/ws" });
    expect(session.workspacePath).toBe("/tmp/ws");
  });

  it("uses options.runtimeHandle when provided (line 43-48)", () => {
    const handle = { id: "rt-1", runtimeName: "tmux", data: {} };
    const session = sessionFromMetadata("app-1", {}, { runtimeHandle: handle });
    expect(session.runtimeHandle).toEqual(handle);
  });

  it("uses null runtimeHandle from options (overriding metadata)", () => {
    const session = sessionFromMetadata(
      "app-1",
      { runtimeHandle: '{"id":"rt-1","runtimeName":"tmux","data":{}}' },
      { runtimeHandle: null },
    );
    expect(session.runtimeHandle).toBeNull();
  });

  it("parses runtimeHandle from metadata JSON when options.runtimeHandle is undefined", () => {
    const session = sessionFromMetadata("app-1", {
      runtimeHandle: '{"id":"rt-1","runtimeName":"tmux","data":{}}',
    });
    expect(session.runtimeHandle).toEqual({ id: "rt-1", runtimeName: "tmux", data: {} });
  });

  it("parses agentInfo from summary in metadata (line 49)", () => {
    const session = sessionFromMetadata("app-1", { summary: "Fixed the login bug" });
    expect(session.agentInfo).toEqual({ summary: "Fixed the login bug", agentSessionId: null });
  });

  it("uses createdAt from metadata when available (line 50)", () => {
    const session = sessionFromMetadata("app-1", { createdAt: "2026-01-01T00:00:00.000Z" });
    expect(session.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("falls back to options.createdAt when metadata createdAt is missing", () => {
    const created = new Date("2025-06-15T12:00:00.000Z");
    const session = sessionFromMetadata("app-1", {}, { createdAt: created });
    expect(session.createdAt).toEqual(created);
  });

  it("uses options.lastActivityAt", () => {
    const lastActivity = new Date("2026-03-30T10:00:00.000Z");
    const session = sessionFromMetadata("app-1", {}, { lastActivityAt: lastActivity });
    expect(session.lastActivityAt).toEqual(lastActivity);
  });

  it("parses restoredAt from metadata (line 51-53)", () => {
    const session = sessionFromMetadata("app-1", { restoredAt: "2026-03-30T10:00:00.000Z" });
    expect(session.restoredAt).toBeInstanceOf(Date);
    expect(session.restoredAt!.toISOString()).toBe("2026-03-30T10:00:00.000Z");
  });

  it("uses options.restoredAt when provided", () => {
    const restored = new Date("2026-01-01T00:00:00.000Z");
    const session = sessionFromMetadata("app-1", {}, { restoredAt: restored });
    expect(session.restoredAt).toEqual(restored);
  });

  it("sets restoredAt to undefined when neither metadata nor options have it", () => {
    const session = sessionFromMetadata("app-1", {});
    expect(session.restoredAt).toBeUndefined();
  });

  it("preserves full metadata record", () => {
    const meta = { project: "app", status: "working", custom: "field" };
    const session = sessionFromMetadata("app-1", meta);
    expect(session.metadata).toEqual(meta);
  });

  it("uses options.activity", () => {
    const session = sessionFromMetadata("app-1", {}, { activity: "idle" as any });
    // activity should match what was passed
    expect(session.activity).toBe("idle");
  });
});
