import { describe, expect, it } from "vitest";
import { isOrchestratorSession, isIssueNotFoundError } from "../types.js";

describe("isOrchestratorSession", () => {
  it("detects orchestrators by explicit role metadata", () => {
    expect(
      isOrchestratorSession({
        id: "app-control",
        metadata: { role: "orchestrator" },
      }),
    ).toBe(true);
  });

  it("falls back to orchestrator naming for legacy sessions", () => {
    expect(isOrchestratorSession({ id: "app-orchestrator", metadata: {} })).toBe(true);
  });

  it("does not classify worker sessions as orchestrators", () => {
    expect(isOrchestratorSession({ id: "app-7", metadata: { role: "worker" } })).toBe(false);
  });

  it("does not false-positive on workers when sessionPrefix ends with -orchestrator", () => {
    // Project with sessionPrefix "my-orchestrator" creates workers like "my-orchestrator-1".
    // These must NOT be classified as orchestrators.
    expect(isOrchestratorSession({ id: "my-orchestrator-1", metadata: {} })).toBe(false);
    expect(isOrchestratorSession({ id: "my-orchestrator-2", metadata: {} })).toBe(false);
  });

  it("still detects suffixed orchestrators via role metadata", () => {
    // Suffixed orchestrators (-orchestrator-2) are detected via their role metadata.
    expect(
      isOrchestratorSession({ id: "app-orchestrator-2", metadata: { role: "orchestrator" } }),
    ).toBe(true);
  });
});

describe("isIssueNotFoundError", () => {
  it("matches 'Issue X not found'", () => {
    expect(isIssueNotFoundError(new Error("Issue INT-9999 not found"))).toBe(true);
  });

  it("matches 'could not resolve to an Issue'", () => {
    expect(isIssueNotFoundError(new Error("Could not resolve to an Issue"))).toBe(true);
  });

  it("matches 'no issue with identifier'", () => {
    expect(isIssueNotFoundError(new Error("No issue with identifier ABC-123"))).toBe(true);
  });

  it("matches 'invalid issue format'", () => {
    expect(isIssueNotFoundError(new Error("Invalid issue format: fix login bug"))).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isIssueNotFoundError(new Error("Unauthorized"))).toBe(false);
    expect(isIssueNotFoundError(new Error("Network timeout"))).toBe(false);
    expect(isIssueNotFoundError(new Error("API key not found"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isIssueNotFoundError(null)).toBe(false);
    expect(isIssueNotFoundError(undefined)).toBe(false);
    expect(isIssueNotFoundError("string")).toBe(false);
  });
});
