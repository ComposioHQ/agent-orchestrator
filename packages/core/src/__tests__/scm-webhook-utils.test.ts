import { describe, it, expect } from "vitest";
import {
  getWebhookHeader,
  parseWebhookJsonObject,
  parseWebhookTimestamp,
  parseWebhookBranchRef,
} from "../scm-webhook-utils.js";

describe("getWebhookHeader", () => {
  it("finds header case-insensitively", () => {
    const headers = { "X-GitHub-Event": "push" };
    expect(getWebhookHeader(headers, "x-github-event")).toBe("push");
  });

  it("returns first element when value is an array", () => {
    const headers = { "X-Forwarded-For": ["1.2.3.4", "5.6.7.8"] };
    expect(getWebhookHeader(headers, "x-forwarded-for")).toBe("1.2.3.4");
  });

  it("returns undefined when header is not found", () => {
    const headers = { "Content-Type": "application/json" };
    expect(getWebhookHeader(headers, "x-missing")).toBeUndefined();
  });

  it("skips non-matching keys", () => {
    const headers = { "Accept": "text/html", "Authorization": "Bearer token" };
    expect(getWebhookHeader(headers, "authorization")).toBe("Bearer token");
  });
});

describe("parseWebhookJsonObject", () => {
  it("parses a valid JSON object", () => {
    expect(parseWebhookJsonObject('{"key":"value"}')).toEqual({ key: "value" });
  });

  it("throws on JSON array", () => {
    expect(() => parseWebhookJsonObject("[1,2,3]")).toThrow("JSON object");
  });

  it("throws on null", () => {
    expect(() => parseWebhookJsonObject("null")).toThrow("JSON object");
  });

  it("throws on primitive", () => {
    expect(() => parseWebhookJsonObject('"hello"')).toThrow("JSON object");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseWebhookJsonObject("not json")).toThrow();
  });
});

describe("parseWebhookTimestamp", () => {
  it("returns Date for valid ISO string", () => {
    const result = parseWebhookTimestamp("2024-01-15T10:30:00Z");
    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe("2024-01-15T10:30:00.000Z");
  });

  it("returns undefined for non-string", () => {
    expect(parseWebhookTimestamp(123)).toBeUndefined();
    expect(parseWebhookTimestamp(null)).toBeUndefined();
    expect(parseWebhookTimestamp(undefined)).toBeUndefined();
  });

  it("returns undefined for invalid date string", () => {
    expect(parseWebhookTimestamp("not-a-date")).toBeUndefined();
  });
});

describe("parseWebhookBranchRef", () => {
  it("strips refs/heads/ prefix", () => {
    expect(parseWebhookBranchRef("refs/heads/main")).toBe("main");
    expect(parseWebhookBranchRef("refs/heads/feat/test")).toBe("feat/test");
  });

  it("returns undefined for other refs/ prefixes", () => {
    expect(parseWebhookBranchRef("refs/tags/v1.0.0")).toBeUndefined();
    expect(parseWebhookBranchRef("refs/remotes/origin/main")).toBeUndefined();
  });

  it("returns bare branch name as-is", () => {
    expect(parseWebhookBranchRef("main")).toBe("main");
    expect(parseWebhookBranchRef("feat/test")).toBe("feat/test");
  });

  it("returns undefined for non-string or empty", () => {
    expect(parseWebhookBranchRef("")).toBeUndefined();
    expect(parseWebhookBranchRef(null)).toBeUndefined();
    expect(parseWebhookBranchRef(123)).toBeUndefined();
    expect(parseWebhookBranchRef(undefined)).toBeUndefined();
  });
});
