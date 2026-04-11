import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getSessionsDir, updateMetadata, writeMetadata } from "@composio/ao-core";
import {
  TerminalAuthError,
  issueMuxConnectToken,
  issueTerminalAccess,
  resetTerminalAuthStateForTests,
  verifyMuxConnectToken,
  verifyTerminalAccess,
} from "../terminal-auth";

describe("terminal-auth", () => {
  let rootDir: string;
  let configPath: string;
  let projectPath: string;
  let sessionsDir: string;
  const previousConfigPath = process.env["AO_CONFIG_PATH"];

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "ao-terminal-auth-"));
    projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    configPath = join(rootDir, "agent-orchestrator.yaml");
    writeFileSync(
      configPath,
      [
        "port: 3000",
        "defaults:",
        "  runtime: tmux",
        "  agent: claude-code",
        "  workspace: worktree",
        "  notifiers: []",
        "projects:",
        "  app:",
        "    name: App",
        `    path: ${JSON.stringify(projectPath)}`,
        '    repo: "acme/app"',
        '    defaultBranch: "main"',
        '    sessionPrefix: "ao"',
        "    scm:",
        '      plugin: "github"',
        "notifiers: {}",
        "notificationRouting:",
        "  urgent: []",
        "  action: []",
        "  warning: []",
        "  info: []",
        "reactions: {}",
        "",
      ].join("\n"),
      "utf-8",
    );

    process.env["AO_CONFIG_PATH"] = configPath;
    resetTerminalAuthStateForTests();
    sessionsDir = getSessionsDir(configPath, projectPath);
    writeMetadata(sessionsDir, "ao-1", {
      worktree: projectPath,
      branch: "feat/ao-1",
      status: "working",
      tmuxName: "123456789abc-ao-1",
      project: "app",
    });
  });

  afterEach(() => {
    resetTerminalAuthStateForTests();
    if (previousConfigPath === undefined) {
      delete process.env["AO_CONFIG_PATH"];
    } else {
      process.env["AO_CONFIG_PATH"] = previousConfigPath;
    }
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("issues a signed terminal grant and verifies it", () => {
    const grant = issueTerminalAccess("ao-1");
    expect(grant.projectId).toBe("app");
    expect(grant.tmuxSessionName).toBe("123456789abc-ao-1");

    const verified = verifyTerminalAccess("ao-1", grant.token);
    expect(verified).toEqual({
      sessionId: "ao-1",
      projectId: "app",
      tmuxSessionName: "123456789abc-ao-1",
      ownerId: expect.any(String),
    });
  });

  it("rejects tampered tokens", () => {
    const grant = issueTerminalAccess("ao-1");
    expect(() => verifyTerminalAccess("ao-1", `${grant.token}tampered`)).toThrow(TerminalAuthError);
  });

  it("rejects tokens for a different session", () => {
    writeMetadata(sessionsDir, "ao-2", {
      worktree: projectPath,
      branch: "feat/ao-2",
      status: "working",
      tmuxName: "123456789abc-ao-2",
      project: "app",
    });

    const grant = issueTerminalAccess("ao-1");
    expect(() => verifyTerminalAccess("ao-2", grant.token)).toThrowError(
      expect.objectContaining({ code: "ownership_denied" }),
    );
  });

  it("rejects missing sessions", () => {
    expect(() => issueTerminalAccess("ao-404")).toThrowError(
      expect.objectContaining({ code: "session_not_found" }),
    );
  });

  it("rate limits repeated terminal grant issuance", () => {
    for (let i = 0; i < 20; i += 1) {
      issueTerminalAccess("ao-1");
    }

    expect(() => issueTerminalAccess("ao-1")).toThrowError(
      expect.objectContaining({ code: "rate_limited", statusCode: 429 }),
    );
  });

  it("rate limits repeated token verification", () => {
    const grant = issueTerminalAccess("ao-1");
    for (let i = 0; i < 40; i += 1) {
      verifyTerminalAccess("ao-1", grant.token);
    }

    expect(() => verifyTerminalAccess("ao-1", grant.token)).toThrowError(
      expect.objectContaining({ code: "rate_limited", statusCode: 429 }),
    );
  });

  it("rejects invalid session ids", () => {
    expect(() => issueTerminalAccess("../bad")).toThrowError(
      expect.objectContaining({ code: "invalid_session", statusCode: 400 }),
    );
  });

  it("rejects missing token fragments", () => {
    expect(() => verifyTerminalAccess("ao-1", "missing-signature")).toThrowError(
      expect.objectContaining({ code: "auth_required", statusCode: 401 }),
    );
  });

  it("rejects invalid token payload json", () => {
    const badPayload = Buffer.from("{not-json", "utf-8").toString("base64url");
    const grant = issueTerminalAccess("ao-1");
    const signature = grant.token.split(".")[1];
    expect(signature).toBeDefined();
    expect(() => verifyTerminalAccess("ao-1", `${badPayload}.${signature}`)).toThrowError(
      expect.objectContaining({ code: "token_invalid", statusCode: 401 }),
    );
  });

  it("rejects expired tokens", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-09T00:00:00.000Z"));
      const grant = issueTerminalAccess("ao-1");
      vi.setSystemTime(new Date("2026-04-09T00:02:00.000Z"));
      expect(() => verifyTerminalAccess("ao-1", grant.token)).toThrowError(
        expect.objectContaining({ code: "token_expired", statusCode: 401 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("still verifies when owner metadata changes after issuance (returns current record)", () => {
    const grant = issueTerminalAccess("ao-1");
    updateMetadata(sessionsDir, "ao-1", { ownerId: "another-owner" });

    const verified = verifyTerminalAccess("ao-1", grant.token);
    expect(verified.ownerId).toBe("another-owner");
  });

  it("still verifies when tmux name metadata changes after issuance", () => {
    const grant = issueTerminalAccess("ao-1");
    updateMetadata(sessionsDir, "ao-1", { tmuxName: "renamed-tmux-session" });

    const verified = verifyTerminalAccess("ao-1", grant.token);
    expect(verified.tmuxSessionName).toBe("renamed-tmux-session");
  });

  it("issues and verifies mux connect tokens", () => {
    const grant = issueMuxConnectToken();
    expect(grant.token).toMatch(/\./);
    verifyMuxConnectToken(grant.token);
  });

  it("rejects invalid mux tokens", () => {
    expect(() => verifyMuxConnectToken("not-a-token")).toThrow(TerminalAuthError);
  });

  it("wraps config load failures as config_unavailable", () => {
    process.env["AO_CONFIG_PATH"] = join(rootDir, "missing.yaml");
    resetTerminalAuthStateForTests();

    expect(() => issueTerminalAccess("ao-1")).toThrowError(
      expect.objectContaining({ code: "config_unavailable", statusCode: 503 }),
    );
  });
});
