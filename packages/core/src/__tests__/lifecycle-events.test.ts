import { describe, it, expect } from "vitest";
import {
  parseDuration,
  inferPriority,
  createEvent,
  statusToEventType,
  prStateToEventType,
  eventToReactionKey,
  transitionLogLevel,
  splitEvidenceSignals,
  makeFingerprint,
} from "../lifecycle-events.js";

describe("lifecycle-events", () => {
  describe("parseDuration", () => {
    it("parses seconds, minutes, hours", () => {
      expect(parseDuration("30s")).toBe(30_000);
      expect(parseDuration("10m")).toBe(600_000);
      expect(parseDuration("2h")).toBe(7_200_000);
    });

    it("returns 0 for malformed input", () => {
      expect(parseDuration("")).toBe(0);
      expect(parseDuration("10")).toBe(0);
      expect(parseDuration("abc")).toBe(0);
      expect(parseDuration("10d")).toBe(0);
    });
  });

  describe("inferPriority", () => {
    it("returns urgent for stuck/needs_input/errored", () => {
      expect(inferPriority("session.stuck")).toBe("urgent");
      expect(inferPriority("session.needs_input")).toBe("urgent");
      expect(inferPriority("session.errored")).toBe("urgent");
    });

    it("returns action for merge/ready events", () => {
      expect(inferPriority("merge.ready")).toBe("action");
      expect(inferPriority("merge.completed")).toBe("action");
      expect(inferPriority("review.approved")).toBe("action");
    });

    it("returns warning for failures and changes_requested", () => {
      expect(inferPriority("ci.failing")).toBe("warning");
      expect(inferPriority("review.changes_requested")).toBe("warning");
      expect(inferPriority("merge.conflicts")).toBe("warning");
    });

    it("returns info for summary and miscellaneous events", () => {
      expect(inferPriority("summary.all_complete")).toBe("info");
      expect(inferPriority("pr.created")).toBe("info");
    });
  });

  describe("createEvent", () => {
    it("fills in timestamp, id, inferred priority", () => {
      const event = createEvent("ci.failing", {
        sessionId: "s-1",
        projectId: "my-app",
        message: "CI is broken",
      });
      expect(event.type).toBe("ci.failing");
      expect(event.priority).toBe("warning");
      expect(event.sessionId).toBe("s-1");
      expect(event.projectId).toBe("my-app");
      expect(event.message).toBe("CI is broken");
      expect(event.timestamp).toBeInstanceOf(Date);
      expect(event.data).toEqual({});
      expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("honors explicit priority override", () => {
      const event = createEvent("pr.created", {
        sessionId: "s-1",
        projectId: "my-app",
        message: "m",
        priority: "urgent",
      });
      expect(event.priority).toBe("urgent");
    });
  });

  describe("statusToEventType", () => {
    it("maps known statuses to event types", () => {
      expect(statusToEventType(undefined, "working")).toBe("session.working");
      expect(statusToEventType(undefined, "pr_open")).toBe("pr.created");
      expect(statusToEventType(undefined, "ci_failed")).toBe("ci.failing");
      expect(statusToEventType(undefined, "merged")).toBe("merge.completed");
      expect(statusToEventType(undefined, "stuck")).toBe("session.stuck");
    });

    it("returns null for statuses without a transition event", () => {
      expect(statusToEventType(undefined, "spawning")).toBeNull();
      expect(statusToEventType(undefined, "cleanup")).toBeNull();
    });
  });

  describe("prStateToEventType", () => {
    it("emits pr.closed when transitioning to closed", () => {
      expect(prStateToEventType("open", "closed")).toBe("pr.closed");
    });

    it("returns null when state did not change", () => {
      expect(prStateToEventType("open", "open")).toBeNull();
    });

    it("returns null for merged transitions (handled via status map)", () => {
      expect(prStateToEventType("open", "merged")).toBeNull();
    });
  });

  describe("eventToReactionKey", () => {
    it("maps known events to reaction keys", () => {
      expect(eventToReactionKey("ci.failing")).toBe("ci-failed");
      expect(eventToReactionKey("review.changes_requested")).toBe("changes-requested");
      expect(eventToReactionKey("automated_review.found")).toBe("bugbot-comments");
      expect(eventToReactionKey("merge.conflicts")).toBe("merge-conflicts");
      expect(eventToReactionKey("session.stuck")).toBe("agent-stuck");
    });

    it("returns null for events without a reaction", () => {
      expect(eventToReactionKey("pr.created")).toBeNull();
      expect(eventToReactionKey("session.working")).toBeNull();
    });
  });

  describe("transitionLogLevel", () => {
    it("escalates urgent priorities to error level", () => {
      expect(transitionLogLevel("stuck")).toBe("error");
      expect(transitionLogLevel("needs_input")).toBe("error");
    });

    it("maps warning priorities to warn level", () => {
      expect(transitionLogLevel("ci_failed")).toBe("warn");
      expect(transitionLogLevel("changes_requested")).toBe("warn");
    });

    it("defaults to info", () => {
      expect(transitionLogLevel("working")).toBe("info");
      expect(transitionLogLevel("merged")).toBe("info");
    });
  });

  describe("splitEvidenceSignals", () => {
    it("splits on whitespace and drops empties", () => {
      expect(splitEvidenceSignals("  a  b\tc\nd  ")).toEqual(["a", "b", "c", "d"]);
      expect(splitEvidenceSignals("")).toEqual([]);
    });
  });

  describe("makeFingerprint", () => {
    it("is order-independent", () => {
      expect(makeFingerprint(["b", "a", "c"])).toBe(makeFingerprint(["c", "a", "b"]));
    });

    it("differs when the set changes", () => {
      expect(makeFingerprint(["a", "b"])).not.toBe(makeFingerprint(["a", "b", "c"]));
    });
  });
});
