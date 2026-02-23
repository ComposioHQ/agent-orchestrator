import { describe, it, expect, vi } from "vitest";
import type { Session, SCM, ProjectConfig, PRInfo } from "@composio/ao-core";
import { detectSessionPR } from "../../src/lib/scm-data.js";

/** Build a minimal Session for testing. */
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

/** Build a minimal ProjectConfig for testing. */
function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "My App",
    repo: "org/my-app",
    path: "/tmp/my-app",
    defaultBranch: "main",
    sessionPrefix: "app",
    ...overrides,
  };
}

/** Build a mock SCM with configurable detectPR behavior. */
function makeSCM(detectPR: SCM["detectPR"]): SCM {
  return {
    name: "github",
    detectPR,
    getCISummary: vi.fn(),
    getReviewDecision: vi.fn(),
    getPendingComments: vi.fn(),
    getAutomatedComments: vi.fn(),
    getCIChecks: vi.fn(),
    getReviews: vi.fn(),
    getMergeability: vi.fn(),
    getPRState: vi.fn(),
    mergePR: vi.fn(),
    closePR: vi.fn(),
  } as unknown as SCM;
}

const PR_URL = "https://github.com/org/my-app/pull/42";

const mockPRInfo: PRInfo = {
  number: 42,
  url: PR_URL,
  title: "Test PR",
  owner: "org",
  repo: "my-app",
  branch: "feat/test",
  baseBranch: "main",
  isDraft: false,
};

describe("detectSessionPR", () => {
  it("returns nulls when no metadata URL and no SCM", async () => {
    const session = makeSession();
    const result = await detectSessionPR(session, null, undefined);

    expect(result.prNumber).toBeNull();
    expect(result.prUrl).toBe("");
    expect(result.prInfo).toBeNull();
  });

  it("extracts PR number from metadata URL when no SCM provided", async () => {
    const session = makeSession({ metadata: { pr: PR_URL } });
    const result = await detectSessionPR(session, null, undefined);

    expect(result.prNumber).toBe(42);
    expect(result.prUrl).toBe(PR_URL);
    expect(result.prInfo).toBeNull();
  });

  it("extracts PR number from metadata URL when SCM provided but project undefined", async () => {
    const scm = makeSCM(vi.fn());
    const session = makeSession({ metadata: { pr: PR_URL } });
    const result = await detectSessionPR(session, scm, undefined);

    expect(result.prNumber).toBe(42);
    expect(result.prUrl).toBe(PR_URL);
    expect(result.prInfo).toBeNull();
    // SCM should NOT be called when project is undefined
    expect(scm.detectPR).not.toHaveBeenCalled();
  });

  it("uses SCM detectPR result when available", async () => {
    const detectPR = vi.fn().mockResolvedValue(mockPRInfo);
    const scm = makeSCM(detectPR);
    const session = makeSession();
    const project = makeProject();

    const result = await detectSessionPR(session, scm, project);

    expect(result.prNumber).toBe(42);
    expect(result.prUrl).toBe(PR_URL);
    expect(result.prInfo).toBe(mockPRInfo);
    expect(detectPR).toHaveBeenCalledWith(session, project);
  });

  it("SCM result overrides metadata URL fallback", async () => {
    const scmPR: PRInfo = { ...mockPRInfo, number: 99, url: "https://github.com/org/my-app/pull/99" };
    const detectPR = vi.fn().mockResolvedValue(scmPR);
    const scm = makeSCM(detectPR);
    const session = makeSession({ metadata: { pr: PR_URL } });
    const project = makeProject();

    const result = await detectSessionPR(session, scm, project);

    // SCM result should override the metadata URL
    expect(result.prNumber).toBe(99);
    expect(result.prUrl).toBe("https://github.com/org/my-app/pull/99");
    expect(result.prInfo).toBe(scmPR);
  });

  it("falls back to metadata URL when SCM detectPR throws", async () => {
    const detectPR = vi.fn().mockRejectedValue(new Error("gh failed"));
    const scm = makeSCM(detectPR);
    const session = makeSession({ metadata: { pr: PR_URL } });
    const project = makeProject();

    const result = await detectSessionPR(session, scm, project);

    expect(result.prNumber).toBe(42);
    expect(result.prUrl).toBe(PR_URL);
    expect(result.prInfo).toBeNull();
  });

  it("returns nulls when SCM detectPR throws and no metadata URL", async () => {
    const detectPR = vi.fn().mockRejectedValue(new Error("gh failed"));
    const scm = makeSCM(detectPR);
    const session = makeSession();
    const project = makeProject();

    const result = await detectSessionPR(session, scm, project);

    expect(result.prNumber).toBeNull();
    expect(result.prUrl).toBe("");
    expect(result.prInfo).toBeNull();
  });

  it("returns nulls when SCM detectPR returns null", async () => {
    const detectPR = vi.fn().mockResolvedValue(null);
    const scm = makeSCM(detectPR);
    const session = makeSession();
    const project = makeProject();

    const result = await detectSessionPR(session, scm, project);

    expect(result.prNumber).toBeNull();
    expect(result.prUrl).toBe("");
    expect(result.prInfo).toBeNull();
  });

  it("keeps metadata URL when SCM detectPR returns null", async () => {
    const detectPR = vi.fn().mockResolvedValue(null);
    const scm = makeSCM(detectPR);
    const session = makeSession({ metadata: { pr: PR_URL } });
    const project = makeProject();

    const result = await detectSessionPR(session, scm, project);

    // Metadata fallback preserved when SCM returns null (no PR detected)
    expect(result.prNumber).toBe(42);
    expect(result.prUrl).toBe(PR_URL);
    expect(result.prInfo).toBeNull();
  });

  it("handles metadata URL without /pull/ pattern gracefully", async () => {
    const session = makeSession({ metadata: { pr: "https://github.com/org/my-app/issues/10" } });
    const result = await detectSessionPR(session, null, undefined);

    // URL doesn't match /pull/N pattern — no PR number extracted
    expect(result.prNumber).toBeNull();
    expect(result.prUrl).toBe("");
    expect(result.prInfo).toBeNull();
  });

  it("works with session that has no branch", async () => {
    const detectPR = vi.fn().mockResolvedValue(null);
    const scm = makeSCM(detectPR);
    const session = makeSession({ branch: null });
    const project = makeProject();

    const result = await detectSessionPR(session, scm, project);

    // Should still call detectPR — the shared helper doesn't gate on branch
    expect(detectPR).toHaveBeenCalledWith(session, project);
    expect(result.prNumber).toBeNull();
    expect(result.prInfo).toBeNull();
  });
});
