import { describe, it, expect } from "vitest";
import {
  getWebhookHeader,
  parseWebhookJsonObject,
  parseWebhookTimestamp,
  parseWebhookBranchRef,
} from "../scm-webhook-utils.js";

describe("getWebhookHeader", () => {
  it("returns header value case-insensitively", () => {
    const headers = { "Content-Type": "application/json" };
    expect(getWebhookHeader(headers, "content-type")).toBe("application/json");
    expect(getWebhookHeader(headers, "CONTENT-TYPE")).toBe("application/json");
  });

  it("returns first element of array-valued header", () => {
    const headers = { "X-Hub-Signature": ["sha256=abc", "sha256=def"] };
    expect(getWebhookHeader(headers, "x-hub-signature")).toBe("sha256=abc");
  });

  it("returns undefined for missing header", () => {
    expect(getWebhookHeader({}, "x-missing")).toBeUndefined();
  });
});

describe("parseWebhookJsonObject", () => {
  it("parses a valid JSON object", () => {
    expect(parseWebhookJsonObject('{"action":"opened"}')).toEqual({ action: "opened" });
  });

  it("throws for JSON arrays", () => {
    expect(() => parseWebhookJsonObject("[1,2,3]")).toThrow("JSON object");
  });

  it("throws for non-object JSON", () => {
    expect(() => parseWebhookJsonObject('"string"')).toThrow("JSON object");
  });

  it("throws for invalid JSON", () => {
    expect(() => parseWebhookJsonObject("not json")).toThrow();
  });
});

describe("parseWebhookTimestamp", () => {
  it("parses a valid ISO timestamp", () => {
    const result = parseWebhookTimestamp("2024-01-15T10:30:00Z");
    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe("2024-01-15T10:30:00.000Z");
  });

  it("returns undefined for non-string values", () => {
    expect(parseWebhookTimestamp(123)).toBeUndefined();
    expect(parseWebhookTimestamp(null)).toBeUndefined();
    expect(parseWebhookTimestamp(undefined)).toBeUndefined();
  });

  it("returns undefined for invalid date strings", () => {
    expect(parseWebhookTimestamp("not-a-date")).toBeUndefined();
  });
});

describe("parseWebhookBranchRef", () => {
  it("strips refs/heads/ prefix", () => {
    expect(parseWebhookBranchRef("refs/heads/main")).toBe("main");
    expect(parseWebhookBranchRef("refs/heads/feat/foo")).toBe("feat/foo");
  });

  it("returns undefined for other refs/ prefixes", () => {
    expect(parseWebhookBranchRef("refs/tags/v1.0")).toBeUndefined();
  });

  it("returns bare branch names as-is", () => {
    expect(parseWebhookBranchRef("main")).toBe("main");
    expect(parseWebhookBranchRef("feat/bar")).toBe("feat/bar");
  });

  it("returns undefined for non-string or empty values", () => {
    expect(parseWebhookBranchRef("")).toBeUndefined();
    expect(parseWebhookBranchRef(123)).toBeUndefined();
    expect(parseWebhookBranchRef(null)).toBeUndefined();
  });
});
