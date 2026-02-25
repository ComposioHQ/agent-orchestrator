import { describe, it, expect } from "vitest";
import type { LinearWebhookPayload } from "../src/types.js";
import { wasLabelAdded, wasMovedToCompleted } from "../src/events.js";

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makePayload(
  overrides: Partial<LinearWebhookPayload> & {
    data?: Partial<LinearWebhookPayload["data"]>;
    updatedFrom?: Partial<LinearWebhookPayload["updatedFrom"]>;
  } = {},
): LinearWebhookPayload {
  return {
    action: "update",
    type: "Issue",
    data: {
      id: "issue-1",
      identifier: "ENG-1",
      title: "Test issue",
      ...overrides.data,
    },
    ...overrides,
    // Re-apply data/updatedFrom after spread so they merge correctly
    ...(overrides.data ? { data: { id: "issue-1", identifier: "ENG-1", title: "Test issue", ...overrides.data } } : {}),
    ...(overrides.updatedFrom !== undefined ? { updatedFrom: overrides.updatedFrom } : {}),
  };
}

// ---------------------------------------------------------------------------
// wasLabelAdded
// ---------------------------------------------------------------------------

describe("wasLabelAdded", () => {
  it("returns true when label is newly added (not in previous labelIds)", () => {
    const payload = makePayload({
      data: {
        labels: [
          { id: "label-1", name: "ao:spawn" },
          { id: "label-2", name: "bug" },
        ],
      },
      updatedFrom: {
        labelIds: ["label-2"],
      },
    });

    expect(wasLabelAdded(payload, "ao:spawn")).toBe(true);
  });

  it("returns false when label was already present (in previous labelIds)", () => {
    const payload = makePayload({
      data: {
        labels: [
          { id: "label-1", name: "ao:spawn" },
          { id: "label-2", name: "bug" },
        ],
      },
      updatedFrom: {
        labelIds: ["label-1", "label-2"],
      },
    });

    expect(wasLabelAdded(payload, "ao:spawn")).toBe(false);
  });

  it("returns false when label not in current labels at all", () => {
    const payload = makePayload({
      data: {
        labels: [{ id: "label-2", name: "bug" }],
      },
      updatedFrom: {
        labelIds: [],
      },
    });

    expect(wasLabelAdded(payload, "ao:spawn")).toBe(false);
  });

  it("is case-insensitive", () => {
    const payload = makePayload({
      data: {
        labels: [{ id: "label-1", name: "AO:Spawn" }],
      },
      updatedFrom: {
        labelIds: [],
      },
    });

    expect(wasLabelAdded(payload, "ao:spawn")).toBe(true);
    expect(wasLabelAdded(payload, "AO:SPAWN")).toBe(true);
    expect(wasLabelAdded(payload, "Ao:Spawn")).toBe(true);
  });

  it("returns false when no labels on payload", () => {
    const payload = makePayload({
      data: {},
      updatedFrom: {
        labelIds: [],
      },
    });

    expect(wasLabelAdded(payload, "ao:spawn")).toBe(false);
  });

  it("returns true when no updatedFrom but label exists (first add — label is new)", () => {
    const payload = makePayload({
      data: {
        labels: [{ id: "label-1", name: "ao:spawn" }],
      },
      updatedFrom: undefined,
    });

    expect(wasLabelAdded(payload, "ao:spawn")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// wasMovedToCompleted
// ---------------------------------------------------------------------------

describe("wasMovedToCompleted", () => {
  it("returns true when state.type is 'completed' and previous was not", () => {
    const payload = makePayload({
      data: {
        state: { id: "state-done", name: "Done", type: "completed" },
      },
      updatedFrom: {
        state: { id: "state-progress", name: "In Progress", type: "started" },
      },
    });

    expect(wasMovedToCompleted(payload)).toBe(true);
  });

  it("returns false when state.type is not 'completed'", () => {
    const payload = makePayload({
      data: {
        state: { id: "state-progress", name: "In Progress", type: "started" },
      },
      updatedFrom: {
        state: { id: "state-triage", name: "Triage", type: "triage" },
      },
    });

    expect(wasMovedToCompleted(payload)).toBe(false);
  });

  it("returns false when already completed (previous state.type was 'completed')", () => {
    const payload = makePayload({
      data: {
        state: { id: "state-done", name: "Done", type: "completed" },
      },
      updatedFrom: {
        state: { id: "state-done-alt", name: "Deployed", type: "completed" },
      },
    });

    expect(wasMovedToCompleted(payload)).toBe(false);
  });

  it("returns false when no state on payload", () => {
    const payload = makePayload({
      data: {},
      updatedFrom: {},
    });

    expect(wasMovedToCompleted(payload)).toBe(false);
  });

  it("returns true when no previous state provided (first time completing)", () => {
    const payload = makePayload({
      data: {
        state: { id: "state-done", name: "Done", type: "completed" },
      },
      updatedFrom: undefined,
    });

    expect(wasMovedToCompleted(payload)).toBe(true);
  });
});
