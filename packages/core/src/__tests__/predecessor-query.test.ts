import { describe, expect, it, vi } from "vitest";
import { PredecessorQueryService } from "../predecessor-query.js";
import type { Session, SessionManager } from "../types.js";

function makeSession(
  id: string,
  lastActivityAt: Date,
  metadata: Record<string, string>,
  projectId = "app",
): Session {
  return {
    id,
    projectId,
    status: "working",
    activity: "idle",
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt,
    metadata,
  };
}

describe("PredecessorQueryService", () => {
  it("queries most recent suspended predecessor by role and re-suspends it", async () => {
    const sessions = [
      makeSession("old-1", new Date("2026-01-01T00:00:00Z"), { suspended: "true", role: "coder" }),
      makeSession("old-2", new Date("2026-01-02T00:00:00Z"), { suspended: "true", role: "coder" }),
      makeSession("old-3", new Date("2026-01-03T00:00:00Z"), { suspended: "false", role: "coder" }),
    ];
    const sessionManager = {
      list: vi.fn(async () => sessions),
    } as unknown as SessionManager;
    const ops = {
      resume: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      capture: vi.fn(async () => "Use the existing migration helper."),
      suspend: vi.fn(async () => {}),
    };
    const service = new PredecessorQueryService(sessionManager, ops);

    const result = await service.query({
      currentSession: makeSession("new-1", new Date("2026-01-04T00:00:00Z"), {}, "app"),
      question: "How did you solve migrations?",
      role: "coder",
    });

    expect(result).toEqual({
      predecessorSessionId: "old-2",
      response: "Use the existing migration helper.",
    });
    expect(ops.resume).toHaveBeenCalledWith("old-2");
    expect(ops.send).toHaveBeenCalledWith("old-2", "How did you solve migrations?");
    expect(ops.suspend).toHaveBeenCalledWith("old-2");
  });

  it("returns null when no suspended predecessors exist", async () => {
    const sessionManager = {
      list: vi.fn(async () => [makeSession("old-1", new Date(), { suspended: "false" })]),
    } as unknown as SessionManager;
    const ops = {
      resume: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      capture: vi.fn(async () => ""),
      suspend: vi.fn(async () => {}),
    };
    const service = new PredecessorQueryService(sessionManager, ops);

    const result = await service.query({
      currentSession: makeSession("new-1", new Date(), {}, "app"),
      question: "Any context?",
    });
    expect(result).toBeNull();
    expect(ops.resume).not.toHaveBeenCalled();
  });

  it("handles string lastActivityAt values from serialized stores", async () => {
    const sessions = [
      {
        ...makeSession("old-1", new Date("2026-01-01T00:00:00Z"), { suspended: "true", role: "coder" }),
        lastActivityAt: "2026-01-01T00:00:00Z",
      },
      {
        ...makeSession("old-2", new Date("2026-01-02T00:00:00Z"), { suspended: "true", role: "coder" }),
        lastActivityAt: "2026-01-02T00:00:00Z",
      },
    ] as unknown as Session[];

    const sessionManager = {
      list: vi.fn(async () => sessions),
    } as unknown as SessionManager;
    const ops = {
      resume: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      capture: vi.fn(async () => "from string timestamp"),
      suspend: vi.fn(async () => {}),
    };
    const service = new PredecessorQueryService(sessionManager, ops);

    const result = await service.query({
      currentSession: makeSession("new-1", new Date(), {}, "app"),
      question: "What changed?",
      role: "coder",
    });

    expect(result?.predecessorSessionId).toBe("old-2");
  });
});
