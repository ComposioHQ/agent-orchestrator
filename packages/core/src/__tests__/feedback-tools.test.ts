import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

  it("is stable when case-only evidence changes alter default sort order", () => {
    const keyA = generateFeedbackDedupeKey(FEEDBACK_TOOL_NAMES.BUG_REPORT, {
      ...validPayload,
      evidence: ["BETA", "alpha"],
    });
    const keyB = generateFeedbackDedupeKey(FEEDBACK_TOOL_NAMES.BUG_REPORT, {
      ...validPayload,
      evidence: ["beta", "alpha"],
    });

    expect(keyA).toBe(keyB);
  });

  it("is stable when only confidence changes", () => {
    const keyA = generateFeedbackDedupeKey(FEEDBACK_TOOL_NAMES.BUG_REPORT, {
      ...validPayload,
      confidence: 0.21,
    });
    const keyB = generateFeedbackDedupeKey(FEEDBACK_TOOL_NAMES.BUG_REPORT, {
      ...validPayload,
      confidence: 0.99,
    });

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

  it("does not collide when one evidence item contains pipes", () => {
    const keyA = generateFeedbackDedupeKey(FEEDBACK_TOOL_NAMES.BUG_REPORT, {
      ...validPayload,
      evidence: ["a|b"],
    });
    const keyB = generateFeedbackDedupeKey(FEEDBACK_TOOL_NAMES.BUG_REPORT, {
      ...validPayload,
      evidence: ["a", "b"],
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

  it("skips corrupt report files and returns valid ones", () => {
    const store = new FeedbackReportStore(reportsDir);

    const saved = store.persist(FEEDBACK_TOOL_NAMES.BUG_REPORT, validPayload);
    writeFileSync(
      join(reportsDir, "report_2026-03-10T00-00-00-000Z_bad.kv"),
      "version=1\nid=report_2026-03-10T00-00-00-000Z_bad\ntool=bug_report\n",
      "utf-8",
    );

    const records = store.list();
    expect(records).toEqual([saved]);
  });

  it("returns empty array when reports directory does not exist (line 181)", () => {
    const nonExistentDir = join(tmpdir(), `ao-feedback-nonexistent-${randomUUID()}`);
    const store = new FeedbackReportStore(nonExistentDir);
    const records = store.list();
    expect(records).toEqual([]);
  });

  it("skips non-report files in the directory (line 185)", () => {
    const store = new FeedbackReportStore(reportsDir);
    store.persist(FEEDBACK_TOOL_NAMES.BUG_REPORT, validPayload);

    // Write a file that doesn't match the report_*.kv pattern
    writeFileSync(join(reportsDir, "not-a-report.txt"), "random content", "utf-8");
    writeFileSync(join(reportsDir, "config.kv"), "key=value\n", "utf-8");

    const records = store.list();
    expect(records).toHaveLength(1);
  });

  it("skips entries that are not regular files (line 190)", () => {
    const store = new FeedbackReportStore(reportsDir);
    store.persist(FEEDBACK_TOOL_NAMES.BUG_REPORT, validPayload);

    // Create a directory that matches the report pattern — statSync().isFile() returns false
    mkdirSync(join(reportsDir, "report_dir-entry_abcd1234.kv"), { recursive: true });

    const records = store.list();
    expect(records).toHaveLength(1);
  });

  it("throws on invalid tool type in parseReportFile (line 131)", () => {
    const store = new FeedbackReportStore(reportsDir);

    // Write a report file with an invalid tool type
    writeFileSync(
      join(reportsDir, "report_2026-03-10T00-00-00-000Z_invalid.kv"),
      [
        "version=1",
        "id=report_2026-03-10T00-00-00-000Z_invalid",
        "tool=invalid_tool_type",
        "createdAt=2026-03-10T00:00:00.000Z",
        "dedupeKey=test-dedupe-key-001",
        "title=test",
        "body=test",
        "session=test",
        "source=test",
        "confidence=0.5",
        "evidence.0=test",
      ].join("\n") + "\n",
      "utf-8",
    );

    // The list() method catches parse errors and skips, so this should not throw
    const records = store.list();
    expect(records).toEqual([]);
  });

  it("validates improvement_suggestion tool input correctly", () => {
    const result = validateFeedbackToolInput(
      FEEDBACK_TOOL_NAMES.IMPROVEMENT_SUGGESTION,
      validPayload,
    );
    expect(result.title).toBe(validPayload.title);
  });
});
