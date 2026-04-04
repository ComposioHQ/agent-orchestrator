import { describe, expect, it } from "vitest";
import { isOrchestratorSession, isIssueNotFoundError } from "../types.js";

describe("isOrchestratorSession", () => {
  it("detects orchestrators by explicit role metadata", () => {
    expect(
      isOrchestratorSession({ id: "app-control", metadata: { role: "orchestrator" } }, "app"),
    ).toBe(true);
  });

  it("falls back to orchestrator naming for legacy sessions", () => {
    expect(isOrchestratorSession({ id: "app-orchestrator", metadata: {} }, "app")).toBe(true);
  });

  it("detects numbered worktree orchestrators by prefix pattern", () => {
    expect(isOrchestratorSession({ id: "app-orchestrator-1", metadata: {} }, "app")).toBe(true);
    expect(isOrchestratorSession({ id: "app-orchestrator-42", metadata: {} }, "app")).toBe(true);
  });

  it("does not false-positive on worker sessions", () => {
    expect(isOrchestratorSession({ id: "app-7", metadata: { role: "worker" } }, "app")).toBe(false);
  });

  it("does not false-positive when prefix ends with -orchestrator", () => {
    // my-orchestrator-1 is a worker when prefix is "my-orchestrator"
    expect(
      isOrchestratorSession({ id: "my-orchestrator-1", metadata: {} }, "my-orchestrator"),
    ).toBe(false);
    // my-orchestrator-orchestrator-1 is the real worktree orchestrator
    expect(
      isOrchestratorSession(
        { id: "my-orchestrator-orchestrator-1", metadata: {} },
        "my-orchestrator",
      ),
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
