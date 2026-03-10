import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  FEEDBACK_TOOL_CONTRACTS,
  FEEDBACK_TOOL_NAMES,
  FeedbackReportStore,
  generateFeedbackDedupeKey,
  validateFeedbackToolInput,
} from "../feedback-tools.js";

const validPayload = {
  title: "Login failure for SSO users",
  body: "Users with Google SSO are looped back to login.",
  evidence: ["trace_id=abc123", "Video capture from session"],
  session: "ao-22",
  source: "agent",
  confidence: 0.82,
};

describe("feedback tool contracts", () => {
  it("defines both v1 tool contracts", () => {
    expect(Object.keys(FEEDBACK_TOOL_CONTRACTS).sort()).toEqual([
      FEEDBACK_TOOL_NAMES.BUG_REPORT,
      FEEDBACK_TOOL_NAMES.IMPROVEMENT_SUGGESTION,
    ]);
  });

  it("validates required fields for bug_report", () => {
    expect(() =>
      validateFeedbackToolInput(FEEDBACK_TOOL_NAMES.BUG_REPORT, {
        ...validPayload,
        title: "",
      }),
    ).toThrow();

    expect(() =>
      validateFeedbackToolInput(FEEDBACK_TOOL_NAMES.BUG_REPORT, {
        ...validPayload,
        body: "",
      }),
    ).toThrow();

    expect(() =>
      validateFeedbackToolInput(FEEDBACK_TOOL_NAMES.BUG_REPORT, {
        ...validPayload,
        evidence: [],
      }),
    ).toThrow();

    expect(() =>
      validateFeedbackToolInput(FEEDBACK_TOOL_NAMES.BUG_REPORT, {
        ...validPayload,
        session: "",
      }),
    ).toThrow();

    expect(() =>
      validateFeedbackToolInput(FEEDBACK_TOOL_NAMES.BUG_REPORT, {
        ...validPayload,
        source: "",
      }),
    ).toThrow();
  });

  it("rejects malformed confidence", () => {
    expect(() =>
      validateFeedbackToolInput(FEEDBACK_TOOL_NAMES.IMPROVEMENT_SUGGESTION, {
        ...validPayload,
        confidence: -0.1,
      }),
    ).toThrow();

    expect(() =>
      validateFeedbackToolInput(FEEDBACK_TOOL_NAMES.IMPROVEMENT_SUGGESTION, {
        ...validPayload,
        confidence: 1.1,
      }),
    ).toThrow();

    expect(() =>
      validateFeedbackToolInput(FEEDBACK_TOOL_NAMES.IMPROVEMENT_SUGGESTION, {
        ...validPayload,
        confidence: Number.NaN,
      }),
    ).toThrow();
  });
});

describe("feedback dedupe key", () => {
  it("is stable for whitespace/case differences and evidence ordering", () => {
    const keyA = generateFeedbackDedupeKey(FEEDBACK_TOOL_NAMES.BUG_REPORT, {
      ...validPayload,
      title: " Login   failure FOR SSO users ",
      body: "Users with Google SSO are looped back to login.",
      evidence: ["Video capture from session", "trace_id=abc123"],
      source: "Agent",
    });

    const keyB = generateFeedbackDedupeKey(FEEDBACK_TOOL_NAMES.BUG_REPORT, validPayload);

    expect(keyA).toBe(keyB);
  });

  it("changes when normalized content differs", () => {
    const keyA = generateFeedbackDedupeKey(FEEDBACK_TOOL_NAMES.BUG_REPORT, validPayload);
    const keyB = generateFeedbackDedupeKey(FEEDBACK_TOOL_NAMES.BUG_REPORT, {
      ...validPayload,
      body: "Users with Google SSO see a 500 after callback.",
    });

    expect(keyA).not.toBe(keyB);
  });
});

describe("feedback report store", () => {
  let reportsDir: string;

  beforeEach(() => {
    reportsDir = join(tmpdir(), `ao-feedback-${randomUUID()}`);
    mkdirSync(reportsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(reportsDir, { recursive: true, force: true });
  });

  it("persists and reads structured feedback reports", () => {
    const store = new FeedbackReportStore(reportsDir);

    const saved = store.persist(FEEDBACK_TOOL_NAMES.BUG_REPORT, validPayload);
    const records = store.list();

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(saved);
    expect(records[0]?.tool).toBe(FEEDBACK_TOOL_NAMES.BUG_REPORT);
    expect(records[0]?.dedupeKey).toMatch(/^[a-f0-9]{16}$/);
  });

  it("does not allow invalid reports to be persisted", () => {
    const store = new FeedbackReportStore(reportsDir);

    expect(() =>
      store.persist(FEEDBACK_TOOL_NAMES.IMPROVEMENT_SUGGESTION, {
        ...validPayload,
        evidence: [],
      }),
    ).toThrow();
  });
});
