import { describe, it, expect } from "vitest";
import { wasLabelAdded, wasMovedToCompleted } from "../src/events.js";
import type { LinearWebhookPayload } from "../src/types.js";

function makePayload(overrides: Partial<LinearWebhookPayload> = {}): LinearWebhookPayload {
  return {
    action: "update",
    type: "Issue",
    data: {
      id: "issue-1",
      identifier: "ENG-123",
      title: "Test issue",
    },
    ...overrides,
  };
}

describe("wasLabelAdded", () => {
  it("returns true when label is newly added", () => {
    const payload = makePayload({
      data: {
        id: "issue-1",
        identifier: "ENG-123",
        title: "Test issue",
        labels: [{ id: "label-1", name: "agent-ready" }],
      },
      updatedFrom: {
        labelIds: [],
      },
    });
    expect(wasLabelAdded(payload, "agent-ready")).toBe(true);
  });

  it("returns false when label was already present", () => {
    const payload = makePayload({
      data: {
        id: "issue-1",
        identifier: "ENG-123",
        title: "Test issue",
        labels: [{ id: "label-1", name: "agent-ready" }],
      },
      updatedFrom: {
        labelIds: ["label-1"],
      },
    });
    expect(wasLabelAdded(payload, "agent-ready")).toBe(false);
  });

  it("returns false when label not in current labels", () => {
    const payload = makePayload({
      data: {
        id: "issue-1",
        identifier: "ENG-123",
        title: "Test issue",
        labels: [{ id: "label-2", name: "bug" }],
      },
      updatedFrom: {
        labelIds: [],
      },
    });
    expect(wasLabelAdded(payload, "agent-ready")).toBe(false);
  });

  it("is case-insensitive", () => {
    const payload = makePayload({
      data: {
        id: "issue-1",
        identifier: "ENG-123",
        title: "Test issue",
        labels: [{ id: "label-1", name: "Agent-Ready" }],
      },
      updatedFrom: {
        labelIds: [],
      },
    });
    expect(wasLabelAdded(payload, "agent-ready")).toBe(true);
  });

  it("returns false when labels array is missing", () => {
    const payload = makePayload({
      data: {
        id: "issue-1",
        identifier: "ENG-123",
        title: "Test issue",
      },
    });
    expect(wasLabelAdded(payload, "agent-ready")).toBe(false);
  });
});

describe("wasMovedToCompleted", () => {
  it("returns true when state.type becomes 'completed'", () => {
    const payload = makePayload({
      data: {
        id: "issue-1",
        identifier: "ENG-123",
        title: "Test issue",
        state: { id: "state-done", name: "Done", type: "completed" },
      },
      updatedFrom: {
        state: { id: "state-in-progress", name: "In Progress", type: "started" },
      },
    });
    expect(wasMovedToCompleted(payload)).toBe(true);
  });

  it("returns false when already completed (no state change)", () => {
    const payload = makePayload({
      data: {
        id: "issue-1",
        identifier: "ENG-123",
        title: "Test issue",
        state: { id: "state-done", name: "Done", type: "completed" },
      },
      updatedFrom: {
        state: { id: "state-done-old", name: "Done", type: "completed" },
      },
    });
    expect(wasMovedToCompleted(payload)).toBe(false);
  });

  it("returns false when no state on issue", () => {
    const payload = makePayload({
      data: {
        id: "issue-1",
        identifier: "ENG-123",
        title: "Test issue",
      },
    });
    expect(wasMovedToCompleted(payload)).toBe(false);
  });

  it("returns true when moved to completed with no previous state info", () => {
    const payload = makePayload({
      data: {
        id: "issue-1",
        identifier: "ENG-123",
        title: "Test issue",
        state: { id: "state-done", name: "Done", type: "completed" },
      },
    });
    expect(wasMovedToCompleted(payload)).toBe(true);
  });
});
