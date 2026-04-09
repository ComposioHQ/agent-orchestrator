import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionsDir, writeMetadata } from "@composio/ao-core";
import {
  issueTerminalAccess,
  resetTerminalAuthStateForTests,
  verifyTerminalAccess,
  verifyTerminalAccessNoRateLimit,
} from "../terminal-auth.js";

const TEST_ACTOR = "terminal-auth-tester";
const TEST_SESSION = "ao-321";

let tempRoot: string;
let projectDir: string;
let sessionsDir: string;
let previousConfigPath: string | undefined;
let previousTerminalActorId: string | undefined;
let previousTrustProxyHeaders: string | undefined;

function writeConfig(configPath: string, rootProjectDir: string): void {
  writeFileSync(
    configPath,
    `port: 3000
defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
  notifiers: []
projects:
  terminal-fixtures:
    name: Terminal Fixtures
    repo: acme/terminal-fixtures
    path: ${JSON.stringify(rootProjectDir)}
    defaultBranch: main
    sessionPrefix: ao
    tracker:
      plugin: github
    scm:
      plugin: github
`,
    "utf-8",
  );
}

function ensureSessionMetadata(sessionId: string): void {
  writeMetadata(sessionsDir, sessionId, {
    worktree: projectDir,
    branch: `session/${sessionId}`,
    status: "working",
    project: "terminal-fixtures",
    ownerId: TEST_ACTOR,
    ownerSource: "test",
    tmuxName: `${sessionId}-tmux`,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("terminal auth", () => {
  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "ao-terminal-auth-unit-"));
    projectDir = join(tempRoot, "terminal-fixtures");
    mkdirSync(projectDir, { recursive: true });

    const configPath = join(tempRoot, "agent-orchestrator.yaml");
    writeConfig(configPath, projectDir);

    previousConfigPath = process.env.AO_CONFIG_PATH;
    previousTerminalActorId = process.env.AO_TERMINAL_ACTOR_ID;
    previousTrustProxyHeaders = process.env.AO_TRUST_PROXY_HEADERS;
    process.env.AO_CONFIG_PATH = configPath;
    process.env.AO_TERMINAL_ACTOR_ID = TEST_ACTOR;
    Reflect.deleteProperty(process.env, "AO_TRUST_PROXY_HEADERS");
    sessionsDir = getSessionsDir(configPath, projectDir);
  });

  beforeEach(() => {
    resetTerminalAuthStateForTests();
  });

  afterAll(() => {
    resetTerminalAuthStateForTests();
    if (previousConfigPath === undefined) {
      Reflect.deleteProperty(process.env, "AO_CONFIG_PATH");
    } else {
      process.env.AO_CONFIG_PATH = previousConfigPath;
    }
    if (previousTerminalActorId === undefined) {
      Reflect.deleteProperty(process.env, "AO_TERMINAL_ACTOR_ID");
    } else {
      process.env.AO_TERMINAL_ACTOR_ID = previousTerminalActorId;
    }
    if (previousTrustProxyHeaders === undefined) {
      Reflect.deleteProperty(process.env, "AO_TRUST_PROXY_HEADERS");
    } else {
      process.env.AO_TRUST_PROXY_HEADERS = previousTrustProxyHeaders;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("ignores malformed unrelated cookies when the terminal cookie is valid", () => {
    ensureSessionMetadata(TEST_SESSION);

    const grant = issueTerminalAccess({
      sessionId: TEST_SESSION,
      headers: {},
    });

    const authorized = verifyTerminalAccess({
      sessionId: TEST_SESSION,
      headers: {
        cookie: `broken=%ZZ; ${grant.cookieName}=${encodeURIComponent(grant.token)}`,
      },
    });

    expect(authorized.sessionId).toBe(TEST_SESSION);
    expect(authorized.tmuxSessionName).toBe(`${TEST_SESSION}-tmux`);
    expect(authorized.actorId).toBe(TEST_ACTOR);
  });

  it("does not trust proxy identity headers by default", () => {
    const sessionId = "ao-proxy-headers-off";
    writeMetadata(sessionsDir, sessionId, {
      worktree: projectDir,
      branch: `session/${sessionId}`,
      status: "working",
      project: "terminal-fixtures",
      ownerId: "proxy-owner",
      ownerSource: "test",
      tmuxName: `${sessionId}-tmux`,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(() =>
      issueTerminalAccess({
        sessionId,
        headers: { "x-forwarded-user": "proxy-owner" },
      }),
    ).toThrow("Session ownership denied");
  });

  it("trusts proxy identity headers only when AO_TRUST_PROXY_HEADERS=true", () => {
    process.env.AO_TRUST_PROXY_HEADERS = "true";

    const sessionId = "ao-proxy-headers-on";
    writeMetadata(sessionsDir, sessionId, {
      worktree: projectDir,
      branch: `session/${sessionId}`,
      status: "working",
      project: "terminal-fixtures",
      ownerId: "proxy-owner",
      ownerSource: "test",
      tmuxName: `${sessionId}-tmux`,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const grant = issueTerminalAccess({
      sessionId,
      headers: { "x-forwarded-user": "proxy-owner" },
      remoteAddress: "127.0.0.1",
    });

    expect(grant.actorId).toBe("proxy-owner");
    expect(grant.actorSource).toBe("header:x-forwarded-user");
  });

  it("returns auth_required when terminal token cookie is missing", () => {
    ensureSessionMetadata(TEST_SESSION);

    expect(() =>
      verifyTerminalAccess({
        sessionId: TEST_SESSION,
        headers: {},
      }),
    ).toThrow("Missing terminal token");
  });

  it("returns token_invalid when terminal token signature is tampered", () => {
    ensureSessionMetadata(TEST_SESSION);

    const grant = issueTerminalAccess({
      sessionId: TEST_SESSION,
      headers: {},
    });

    const tamperedToken = `${grant.token.slice(0, -1)}X`;
    expect(() =>
      verifyTerminalAccess({
        sessionId: TEST_SESSION,
        headers: {
          cookie: `${grant.cookieName}=${encodeURIComponent(tamperedToken)}`,
        },
      }),
    ).toThrow("Invalid terminal token");
  });

  it("returns token_expired when terminal token is used after expiration", () => {
    ensureSessionMetadata(TEST_SESSION);

    const issuedAt = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(issuedAt);
    const grant = issueTerminalAccess({
      sessionId: TEST_SESSION,
      headers: {},
    });

    nowSpy.mockReturnValue(issuedAt + 61_000);

    expect(() =>
      verifyTerminalAccess({
        sessionId: TEST_SESSION,
        headers: {
          cookie: `${grant.cookieName}=${encodeURIComponent(grant.token)}`,
        },
      }),
    ).toThrow("Terminal token expired");

    nowSpy.mockRestore();
  });

  it("enforces issue rate limit for repeated access grants", () => {
    ensureSessionMetadata(TEST_SESSION);

    for (let i = 0; i < 8; i += 1) {
      const grant = issueTerminalAccess({
        sessionId: TEST_SESSION,
        headers: {},
      });
      expect(grant.sessionId).toBe(TEST_SESSION);
    }

    expect(() =>
      issueTerminalAccess({
        sessionId: TEST_SESSION,
        headers: {},
      }),
    ).toThrow("Terminal access rate limit exceeded");
  });

  it("can verify the same token repeatedly via no-rate-limit verifier", () => {
    ensureSessionMetadata(TEST_SESSION);

    const grant = issueTerminalAccess({
      sessionId: TEST_SESSION,
      headers: {},
    });

    for (let i = 0; i < 20; i += 1) {
      const authorized = verifyTerminalAccessNoRateLimit({
        sessionId: TEST_SESSION,
        headers: {
          cookie: `${grant.cookieName}=${encodeURIComponent(grant.token)}`,
        },
      });
      expect(authorized.sessionId).toBe(TEST_SESSION);
    }
  });

  it("hydrates missing metadata owner from fallback actor", () => {
    const sessionId = "ao-missing-owner";
    writeMetadata(sessionsDir, sessionId, {
      worktree: projectDir,
      branch: `session/${sessionId}`,
      status: "working",
      project: "terminal-fixtures",
      tmuxName: `${sessionId}-tmux`,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const grant = issueTerminalAccess({
      sessionId,
      headers: {},
    });

    expect(grant.ownerId).toBe(TEST_ACTOR);
    expect(grant.ownerSource).toContain("legacy:");
  });
});
