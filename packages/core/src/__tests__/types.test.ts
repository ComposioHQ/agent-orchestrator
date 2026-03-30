import { describe, expect, it } from "vitest";
import {
  isOrchestratorSession,
  isIssueNotFoundError,
  normalizeAgentPermissionMode,
  isOpenCodeSessionManager,
} from "../types.js";

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

describe("normalizeAgentPermissionMode", () => {
  it("returns undefined for undefined input", () => {
    expect(normalizeAgentPermissionMode(undefined)).toBeUndefined();
  });

  it("returns canonical mode for valid modes", () => {
    expect(normalizeAgentPermissionMode("permissionless")).toBe("permissionless");
    expect(normalizeAgentPermissionMode("default")).toBe("default");
    expect(normalizeAgentPermissionMode("auto-edit")).toBe("auto-edit");
    expect(normalizeAgentPermissionMode("suggest")).toBe("suggest");
  });

  it("normalizes 'skip' legacy alias to 'permissionless' (line 1153)", () => {
    expect(normalizeAgentPermissionMode("skip")).toBe("permissionless");
  });

  it("returns undefined for unknown mode strings (line 1154)", () => {
    expect(normalizeAgentPermissionMode("unknown")).toBeUndefined();
    expect(normalizeAgentPermissionMode("")).toBeUndefined();
  });
});

describe("isOpenCodeSessionManager", () => {
  it("returns true when remap function exists (line 1276)", () => {
    const sm = {
      spawn: async () => ({} as any),
      list: async () => [],
      get: async () => null,
      kill: async () => {},
      cleanup: async () => ({ killed: [], skipped: [], errors: [] }),
      send: async () => {},
      claimPR: async () => ({} as any),
      remap: async () => {},
    };
    expect(isOpenCodeSessionManager(sm as any)).toBe(true);
  });

  it("returns false when remap function is missing", () => {
    const sm = {
      spawn: async () => ({} as any),
      list: async () => [],
      get: async () => null,
      kill: async () => {},
      cleanup: async () => ({ killed: [], skipped: [], errors: [] }),
      send: async () => {},
      claimPR: async () => ({} as any),
    };
    expect(isOpenCodeSessionManager(sm as any)).toBe(false);
  });
});
