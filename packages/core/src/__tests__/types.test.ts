import { describe, it, expect } from "vitest";
import {
  isTerminalSession,
  isRestorable,
  isIssueNotFoundError,
  SessionNotRestorableError,
  WorkspaceMissingError,
  TERMINAL_STATUSES,
  TERMINAL_ACTIVITIES,
  NON_RESTORABLE_STATUSES,
  SESSION_STATUS,
  ACTIVITY_STATE,
  PR_STATE,
  CI_STATUS,
  DEFAULT_READY_THRESHOLD_MS,
  type SessionStatus,
  type ActivityState,
} from "../types.js";

// =============================================================================
// isTerminalSession
// =============================================================================

describe("isTerminalSession", () => {
  const terminalStatuses: SessionStatus[] = [
    "killed",
    "terminated",
    "done",
    "cleanup",
    "errored",
    "merged",
  ];

  const activeStatuses: SessionStatus[] = [
    "spawning",
    "working",
    "pr_open",
    "ci_failed",
    "review_pending",
    "changes_requested",
    "approved",
    "mergeable",
    "needs_input",
    "stuck",
  ];

  for (const status of terminalStatuses) {
    it(`returns true for terminal status "${status}" with null activity`, () => {
      expect(isTerminalSession({ status, activity: null })).toBe(true);
    });
  }

  for (const status of activeStatuses) {
    it(`returns false for active status "${status}" with null activity`, () => {
      expect(isTerminalSession({ status, activity: null })).toBe(false);
    });
  }

  it("returns true when activity is exited, regardless of status", () => {
    expect(isTerminalSession({ status: "working", activity: "exited" })).toBe(true);
    expect(isTerminalSession({ status: "spawning", activity: "exited" })).toBe(true);
    expect(isTerminalSession({ status: "pr_open", activity: "exited" })).toBe(true);
  });

  it("returns false for non-terminal status with non-exited activity", () => {
    const activities: ActivityState[] = ["active", "ready", "idle", "waiting_input", "blocked"];
    for (const activity of activities) {
      expect(isTerminalSession({ status: "working", activity })).toBe(false);
    }
  });

  it("returns true when both status and activity are terminal", () => {
    expect(isTerminalSession({ status: "killed", activity: "exited" })).toBe(true);
  });
});

// =============================================================================
// isRestorable
// =============================================================================

describe("isRestorable", () => {
  it("returns true for terminal sessions NOT in non-restorable statuses", () => {
    expect(isRestorable({ status: "killed", activity: null })).toBe(true);
    expect(isRestorable({ status: "terminated", activity: null })).toBe(true);
    expect(isRestorable({ status: "done", activity: null })).toBe(true);
    expect(isRestorable({ status: "errored", activity: null })).toBe(true);
    expect(isRestorable({ status: "cleanup", activity: null })).toBe(true);
  });

  it("returns false for merged status (non-restorable)", () => {
    expect(isRestorable({ status: "merged", activity: null })).toBe(false);
  });

  it("returns false for active (non-terminal) sessions", () => {
    expect(isRestorable({ status: "working", activity: null })).toBe(false);
    expect(isRestorable({ status: "pr_open", activity: null })).toBe(false);
    expect(isRestorable({ status: "spawning", activity: null })).toBe(false);
  });

  it("returns true when activity is exited and status is not merged", () => {
    expect(isRestorable({ status: "working", activity: "exited" })).toBe(true);
  });

  it("returns false when activity is exited but status is merged", () => {
    expect(isRestorable({ status: "merged", activity: "exited" })).toBe(false);
  });
});

// =============================================================================
// isIssueNotFoundError
// =============================================================================

describe("isIssueNotFoundError", () => {
  it("returns false for null/undefined", () => {
    expect(isIssueNotFoundError(null)).toBe(false);
    expect(isIssueNotFoundError(undefined)).toBe(false);
  });

  it("returns false for non-object values", () => {
    expect(isIssueNotFoundError("string")).toBe(false);
    expect(isIssueNotFoundError(42)).toBe(false);
    expect(isIssueNotFoundError(true)).toBe(false);
  });

  it("returns false for object without message", () => {
    expect(isIssueNotFoundError({})).toBe(false);
    expect(isIssueNotFoundError({ code: 404 })).toBe(false);
  });

  it('matches "issue not found" pattern', () => {
    expect(isIssueNotFoundError(new Error("Issue #42 not found"))).toBe(true);
    expect(isIssueNotFoundError(new Error("issue not found"))).toBe(true);
    expect(isIssueNotFoundError(new Error("Issue INT-123 Not Found"))).toBe(true);
  });

  it('matches "issue does not exist" pattern', () => {
    expect(isIssueNotFoundError(new Error("Issue 42 does not exist"))).toBe(true);
  });

  it('matches "no issue found" pattern', () => {
    expect(isIssueNotFoundError(new Error("No issue found for that identifier"))).toBe(true);
  });

  it('matches "could not find issue" pattern', () => {
    expect(isIssueNotFoundError(new Error("Could not find issue INT-999"))).toBe(true);
  });

  it('matches GitHub "could not resolve to an Issue" pattern', () => {
    expect(isIssueNotFoundError(new Error("Could not resolve to an Issue with the number 42"))).toBe(
      true,
    );
  });

  it('matches Linear "no issue with identifier" pattern', () => {
    expect(isIssueNotFoundError(new Error("No issue with identifier INT-1234"))).toBe(true);
  });

  it("does NOT match generic not-found errors (API key, team, etc.)", () => {
    expect(isIssueNotFoundError(new Error("API key not found"))).toBe(false);
    expect(isIssueNotFoundError(new Error("Team not found"))).toBe(false);
    expect(isIssueNotFoundError(new Error("Configuration not found"))).toBe(false);
    expect(isIssueNotFoundError(new Error("Resource does not exist"))).toBe(false);
    expect(isIssueNotFoundError(new Error("Not Found"))).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isIssueNotFoundError(new Error("ISSUE NOT FOUND"))).toBe(true);
    expect(isIssueNotFoundError(new Error("NO ISSUE WITH IDENTIFIER FOO-1"))).toBe(true);
  });
});

// =============================================================================
// SessionNotRestorableError
// =============================================================================

describe("SessionNotRestorableError", () => {
  it("sets name, sessionId, reason, and message correctly", () => {
    const err = new SessionNotRestorableError("app-1", "already merged");
    expect(err.name).toBe("SessionNotRestorableError");
    expect(err.sessionId).toBe("app-1");
    expect(err.reason).toBe("already merged");
    expect(err.message).toBe("Session app-1 cannot be restored: already merged");
  });

  it("is an instance of Error", () => {
    const err = new SessionNotRestorableError("x", "y");
    expect(err).toBeInstanceOf(Error);
  });
});

// =============================================================================
// WorkspaceMissingError
// =============================================================================

describe("WorkspaceMissingError", () => {
  it("sets name and path correctly", () => {
    const err = new WorkspaceMissingError("/tmp/ws");
    expect(err.name).toBe("WorkspaceMissingError");
    expect(err.path).toBe("/tmp/ws");
    expect(err.message).toBe("Workspace missing at /tmp/ws");
  });

  it("includes detail in message when provided", () => {
    const err = new WorkspaceMissingError("/tmp/ws", "directory deleted");
    expect(err.message).toBe("Workspace missing at /tmp/ws: directory deleted");
    expect(err.detail).toBe("directory deleted");
  });

  it("omits detail suffix when detail is undefined", () => {
    const err = new WorkspaceMissingError("/tmp/ws");
    expect(err.detail).toBeUndefined();
    expect(err.message).not.toContain(":");
  });

  it("is an instance of Error", () => {
    const err = new WorkspaceMissingError("/tmp/ws");
    expect(err).toBeInstanceOf(Error);
  });
});

// =============================================================================
// Constants validation
// =============================================================================

describe("TERMINAL_STATUSES", () => {
  it("contains exactly the expected statuses", () => {
    const expected = new Set(["killed", "terminated", "done", "cleanup", "errored", "merged"]);
    expect(TERMINAL_STATUSES).toEqual(expected);
  });

  it("does not contain active statuses", () => {
    expect(TERMINAL_STATUSES.has("working" as SessionStatus)).toBe(false);
    expect(TERMINAL_STATUSES.has("spawning" as SessionStatus)).toBe(false);
    expect(TERMINAL_STATUSES.has("pr_open" as SessionStatus)).toBe(false);
  });
});

describe("TERMINAL_ACTIVITIES", () => {
  it("contains only exited", () => {
    expect(TERMINAL_ACTIVITIES.has("exited")).toBe(true);
    expect(TERMINAL_ACTIVITIES.size).toBe(1);
  });
});

describe("NON_RESTORABLE_STATUSES", () => {
  it("contains only merged", () => {
    expect(NON_RESTORABLE_STATUSES.has("merged")).toBe(true);
    expect(NON_RESTORABLE_STATUSES.size).toBe(1);
  });
});

describe("SESSION_STATUS", () => {
  it("maps all status names to their string values", () => {
    expect(SESSION_STATUS.SPAWNING).toBe("spawning");
    expect(SESSION_STATUS.WORKING).toBe("working");
    expect(SESSION_STATUS.PR_OPEN).toBe("pr_open");
    expect(SESSION_STATUS.CI_FAILED).toBe("ci_failed");
    expect(SESSION_STATUS.REVIEW_PENDING).toBe("review_pending");
    expect(SESSION_STATUS.CHANGES_REQUESTED).toBe("changes_requested");
    expect(SESSION_STATUS.APPROVED).toBe("approved");
    expect(SESSION_STATUS.MERGEABLE).toBe("mergeable");
    expect(SESSION_STATUS.MERGED).toBe("merged");
    expect(SESSION_STATUS.CLEANUP).toBe("cleanup");
    expect(SESSION_STATUS.NEEDS_INPUT).toBe("needs_input");
    expect(SESSION_STATUS.STUCK).toBe("stuck");
    expect(SESSION_STATUS.ERRORED).toBe("errored");
    expect(SESSION_STATUS.KILLED).toBe("killed");
    expect(SESSION_STATUS.DONE).toBe("done");
    expect(SESSION_STATUS.TERMINATED).toBe("terminated");
  });
});

describe("ACTIVITY_STATE", () => {
  it("maps all activity names to their string values", () => {
    expect(ACTIVITY_STATE.ACTIVE).toBe("active");
    expect(ACTIVITY_STATE.READY).toBe("ready");
    expect(ACTIVITY_STATE.IDLE).toBe("idle");
    expect(ACTIVITY_STATE.WAITING_INPUT).toBe("waiting_input");
    expect(ACTIVITY_STATE.BLOCKED).toBe("blocked");
    expect(ACTIVITY_STATE.EXITED).toBe("exited");
  });
});

describe("PR_STATE", () => {
  it("maps all PR state names", () => {
    expect(PR_STATE.OPEN).toBe("open");
    expect(PR_STATE.MERGED).toBe("merged");
    expect(PR_STATE.CLOSED).toBe("closed");
  });
});

describe("CI_STATUS", () => {
  it("maps all CI status names", () => {
    expect(CI_STATUS.PENDING).toBe("pending");
    expect(CI_STATUS.PASSING).toBe("passing");
    expect(CI_STATUS.FAILING).toBe("failing");
    expect(CI_STATUS.NONE).toBe("none");
  });
});

describe("DEFAULT_READY_THRESHOLD_MS", () => {
  it("is 5 minutes in milliseconds", () => {
    expect(DEFAULT_READY_THRESHOLD_MS).toBe(300_000);
  });
});
