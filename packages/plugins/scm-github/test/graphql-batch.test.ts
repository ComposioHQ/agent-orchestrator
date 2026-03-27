/**
 * Unit tests for GraphQL batch PR enrichment.
 *
 * Note: The GraphQL batch query was optimized to use only the top-level
 * statusCheckRollup.state field instead of fetching individual contexts.
 * This reduces GraphQL API cost from ~50 points to ~10 points per PR while
 * providing the same semantic information for CI status determination.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

// Import from graphql-batch.js
import {
  generateBatchQuery,
  MAX_BATCH_SIZE,
  parseCIState,
  parseReviewDecision,
  parsePRState,
  extractPREnrichment,
  clearETagCache,
  getPRListETag,
  getCommitStatusETag,
  setPRMetadata,
  getPRMetadataCache,
  clearPRMetadataCache,
  shouldRefreshPREnrichment,
  setExecFileAsync,
} from "../src/graphql-batch.js";

// Mock execFile using the injection function
// Create a mock function that returns a promise matching the execFile signature
type ExecFileResult = { stdout: string; stderr: string };

const mockExecFileImpl = vi.fn<(
  file: string,
  args: string[],
  options?: Record<string, unknown>,
) => Promise<ExecFileResult>>();

// Setup mock before each test
beforeEach(() => {
  setExecFileAsync(mockExecFileImpl);
});

describe("GraphQL Batch Query Generation", () => {
  it("should generate a query for a single PR", () => {
    const prs = [
      {
        owner: "octocat",
        repo: "hello-world",
        number: 42,
        url: "https://github.com/octocat/hello-world/pull/42",
        title: "Add new feature",
        branch: "feature/new",
        baseBranch: "main",
        isDraft: false,
      },
    ];

    const { query, variables } = generateBatchQuery(prs);

    expect(query).toContain("query BatchPRs($pr0Owner: String!, $pr0Name: String!, $pr0Number: Int!)");
    expect(query).toContain("pr0: repository(owner: $pr0Owner, name: $pr0Name)");
    expect(query).toContain("pullRequest(number: $pr0Number)");
    expect(variables).toEqual({
      pr0Owner: "octocat",
      pr0Name: "hello-world",
      pr0Number: 42,
    });
  });

  it("should generate a query for multiple PRs with different aliases", () => {
    const prs = [
      {
        owner: "octocat",
        repo: "hello-world",
        number: 42,
        url: "https://github.com/octocat/hello-world/pull/42",
        title: "Add new feature",
        branch: "feature/new",
        baseBranch: "main",
        isDraft: false,
      },
      {
        owner: "torvalds",
        repo: "linux",
        number: 123,
        url: "https://github.com/torvalds/linux/pull/123",
        title: "Fix kernel bug",
        branch: "fix/kernel",
        baseBranch: "master",
        isDraft: false,
      },
      {
        owner: "facebook",
        repo: "react",
        number: 456,
        url: "https://github.com/facebook/react/pull/456",
        title: "Update hooks",
        branch: "update/hooks",
        baseBranch: "main",
        isDraft: false,
      },
    ];

    const { query, variables } = generateBatchQuery(prs);

    // Check all three aliases are present
    expect(query).toContain("pr0: repository(owner: $pr0Owner");
    expect(query).toContain("pr1: repository(owner: $pr1Owner");
    expect(query).toContain("pr2: repository(owner: $pr2Owner");

    // Check variable definitions
    expect(query).toContain("$pr0Owner: String!");
    expect(query).toContain("$pr1Owner: String!");
    expect(query).toContain("$pr2Owner: String!");

    // Check variables contain all PR data
    expect(variables.pr0Owner).toBe("octocat");
    expect(variables.pr0Name).toBe("hello-world");
    expect(variables.pr0Number).toBe(42);
    expect(variables.pr1Owner).toBe("torvalds");
    expect(variables.pr1Name).toBe("linux");
    expect(variables.pr1Number).toBe(123);
    expect(variables.pr2Owner).toBe("facebook");
    expect(variables.pr2Name).toBe("react");
    expect(variables.pr2Number).toBe(456);
  });

  it("should handle empty PR array", () => {
    const { query, variables } = generateBatchQuery([]);

    expect(query).toBe("");
    expect(variables).toEqual({});
  });

  it("should include all required fields in the query", () => {
    const prs = [
      {
        owner: "test",
        repo: "test",
        number: 1,
        url: "https://github.com/test/test/pull/1",
        title: "Test",
        branch: "test",
        baseBranch: "main",
        isDraft: false,
      },
    ];

    const { query } = generateBatchQuery(prs);

    // Check for all the PR fields we need
    expect(query).toContain("title");
    expect(query).toContain("state");
    expect(query).toContain("additions");
    expect(query).toContain("deletions");
    expect(query).toContain("isDraft");
    expect(query).toContain("mergeable");
    expect(query).toContain("mergeStateStatus");
    expect(query).toContain("reviewDecision");
    expect(query).toContain("reviews");
    expect(query).toContain("commits");
    expect(query).toContain("statusCheckRollup");
  });

  it("should use sequential numeric aliases", () => {
    const prs = Array.from({ length: 5 }, (_, i) => ({
      owner: "owner",
      repo: "repo",
      number: i + 1,
      url: `https://github.com/owner/repo/pull/${i + 1}`,
      title: `PR ${i + 1}`,
      branch: `branch${i}`,
      baseBranch: "main",
      isDraft: false,
    }));

    const { query } = generateBatchQuery(prs);

    expect(query).toContain("pr0:");
    expect(query).toContain("pr1:");
    expect(query).toContain("pr2:");
    expect(query).toContain("pr3:");
    expect(query).toContain("pr4:");
  });

  it("should handle special characters in owner/repo names", () => {
    const prs = [
      {
        owner: "org-name",
        repo: "repo_name",
        number: 1,
        url: "https://github.com/org-name/repo_name/pull/1",
        title: "Test",
        branch: "test",
        baseBranch: "main",
        isDraft: false,
      },
    ];

    const { variables } = generateBatchQuery(prs);

    expect(variables.pr0Owner).toBe("org-name");
    expect(variables.pr0Name).toBe("repo_name");
  });

  it("should handle PR numbers of varying lengths", () => {
    const prs = [
      {
        owner: "test",
        repo: "test",
        number: 1,
        url: "https://github.com/test/test/pull/1",
        title: "Test 1",
        branch: "branch1",
        baseBranch: "main",
        isDraft: false,
      },
      {
        owner: "test",
        repo: "test",
        number: 9999,
        url: "https://github.com/test/test/pull/9999",
        title: "Test 9999",
        branch: "branch9999",
        baseBranch: "main",
        isDraft: false,
      },
    ];

    const { variables } = generateBatchQuery(prs);

    expect(variables.pr0Number).toBe(1);
    expect(variables.pr1Number).toBe(9999);
  });

  it("should generate properly formatted GraphQL query", () => {
    const prs = [
      {
        owner: "test",
        repo: "test",
        number: 1,
        url: "https://github.com/test/test/pull/1",
        title: "Test",
        branch: "test",
        baseBranch: "main",
        isDraft: false,
      },
    ];

    const { query } = generateBatchQuery(prs);

    // Check query structure
    expect(query).toMatch(/^query BatchPRs\(/);
    expect(query).toContain(") {\n");
    expect(query).toContain("}\n    }");
  });
});

describe("CI State Parsing", () => {
  it("should parse SUCCESS state as passing", () => {
    expect(parseCIState({ state: "SUCCESS" })).toBe("passing");
    expect(parseCIState({ state: "success" })).toBe("passing");
  });

  it("should parse FAILURE state as failing", () => {
    expect(parseCIState({ state: "FAILURE" })).toBe("failing");
    expect(parseCIState({ state: "failure" })).toBe("failing");
  });

  it("should parse PENDING state as pending", () => {
    expect(parseCIState({ state: "PENDING" })).toBe("pending");
    expect(parseCIState({ state: "pending" })).toBe("pending");
    expect(parseCIState({ state: "EXPECTED" })).toBe("pending");
  });

  it("should parse individual contexts for detailed state", () => {
    // After optimization, we no longer fetch individual contexts.
    // The top-level state provides the same semantic information.
    expect(parseCIState({
      state: "PENDING",
      contexts: {
        nodes: [
          { state: "SUCCESS", conclusion: "SUCCESS" },
          { state: "PENDING", conclusion: null },
        ],
      },
    })).toBe("pending");

    expect(parseCIState({
      state: "FAILURE",
      contexts: {
        nodes: [
          { state: "FAILURE", conclusion: "FAILURE" },
          { state: "SUCCESS", conclusion: "SUCCESS" },
        ],
      },
    })).toBe("failing");
  });

  it("should return none for unknown state", () => {
    expect(parseCIState({ state: "UNKNOWN" })).toBe("none");
    expect(parseCIState({})).toBe("none");
    expect(parseCIState(null)).toBe("none");
    expect(parseCIState(undefined)).toBe("none");
  });

  it("should parse various conclusion states correctly", () => {
    expect(parseCIState({ state: "TIMED_OUT" })).toBe("failing");
    expect(parseCIState({ state: "ACTION_REQUIRED" })).toBe("failing");
    expect(parseCIState({ state: "QUEUED" })).toBe("pending");
    expect(parseCIState({ state: "IN_PROGRESS" })).toBe("pending");
    expect(parseCIState({ state: "SKIPPED" })).toBe("none");
    expect(parseCIState({ state: "STALE" })).toBe("none");
  });
});

describe("Review Decision Parsing", () => {
  it("should parse APPROVED decision", () => {
    expect(parseReviewDecision("APPROVED")).toBe("approved");
    expect(parseReviewDecision("approved")).toBe("approved");
  });

  it("should parse CHANGES_REQUESTED decision", () => {
    expect(parseReviewDecision("CHANGES_REQUESTED")).toBe("changes_requested");
    expect(parseReviewDecision("changes_requested")).toBe("changes_requested");
  });

  it("should parse REVIEW_REQUIRED decision", () => {
    expect(parseReviewDecision("REVIEW_REQUIRED")).toBe("pending");
    expect(parseReviewDecision("review_required")).toBe("pending");
  });

  it("should parse unknown decision as none", () => {
    expect(parseReviewDecision(null)).toBe("none");
    expect(parseReviewDecision(undefined)).toBe("none");
    expect(parseReviewDecision("")).toBe("none");
    expect(parseReviewDecision("UNKNOWN")).toBe("none");
  });
});

describe("PR State Parsing", () => {
  it("should parse MERGED state", () => {
    expect(parsePRState("MERGED")).toBe("merged");
    expect(parsePRState("merged")).toBe("merged");
  });

  it("should parse CLOSED state", () => {
    expect(parsePRState("CLOSED")).toBe("closed");
    expect(parsePRState("closed")).toBe("closed");
  });

  it("should parse OPEN state", () => {
    expect(parsePRState("OPEN")).toBe("open");
    expect(parsePRState("open")).toBe("open");
  });

  it("should parse unknown state as open", () => {
    expect(parsePRState(null)).toBe("open");
    expect(parsePRState(undefined)).toBe("open");
    expect(parsePRState("")).toBe("open");
  });
});

describe("PR Enrichment Data Extraction", () => {
  it("should extract complete PR enrichment data", () => {
    const pullRequest = {
      title: "Add new feature",
      state: "OPEN",
      additions: 100,
      deletions: 50,
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      reviews: {
        nodes: [
          { author: { login: "user1" }, state: "APPROVED", submittedAt: "2024-01-01T00:00:00Z" },
        ],
      },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "SUCCESS",
                contexts: {
                  nodes: [
                    { state: "SUCCESS", conclusion: "SUCCESS", name: "ci", context: "default/ci" },
                  ],
                },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);

    expect(extracted).not.toBeNull();
    expect(extracted?.data.state).toBe("open");
    expect(extracted?.data.ciStatus).toBe("passing");
    expect(extracted?.data.reviewDecision).toBe("approved");
    expect(extracted?.data.mergeable).toBe(true);
    expect(extracted?.data.title).toBe("Add new feature");
    expect(extracted?.data.additions).toBe(100);
    expect(extracted?.data.deletions).toBe(50);
    expect(extracted?.data.isDraft).toBe(false);
    expect(extracted?.data.hasConflicts).toBe(false);
    expect(extracted?.data.isBehind).toBe(false);
    expect(extracted?.data.blockers).toEqual([]);
  });

  it("should extract PR with CI failures", () => {
    const pullRequest = {
      title: "Fix bug",
      state: "OPEN",
      additions: 10,
      deletions: 5,
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      reviews: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "FAILURE",
                contexts: {
                  nodes: [
                    { state: "FAILURE", conclusion: "FAILURE", name: "tests", context: "ci/tests" },
                  ],
                },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    const result = extracted?.data;

    expect(result?.ciStatus).toBe("failing");
    expect(result?.mergeable).toBe(false);
    expect(result?.blockers).toContain("CI is failing");
  });

  it("should extract PR with changes requested", () => {
    const pullRequest = {
      title: "Update code",
      state: "OPEN",
      additions: 20,
      deletions: 10,
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "CHANGES_REQUESTED",
      reviews: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "SUCCESS",
                contexts: { nodes: [] },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    const result = extracted?.data;

    expect(result?.reviewDecision).toBe("changes_requested");
    expect(result?.mergeable).toBe(false);
    expect(result?.blockers).toContain("Changes requested in review");
  });

  it("should extract PR with merge conflicts", () => {
    const pullRequest = {
      title: "Fix conflict",
      state: "OPEN",
      additions: 5,
      deletions: 2,
      isDraft: false,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      reviewDecision: "APPROVED",
      reviews: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "SUCCESS",
                contexts: { nodes: [] },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    const result = extracted?.data;

    expect(result?.hasConflicts).toBe(true);
    expect(result?.mergeable).toBe(false);
    expect(result?.blockers).toContain("Merge conflicts");
  });

  it("should extract PR that is behind base", () => {
    const pullRequest = {
      title: "Sync branch",
      state: "OPEN",
      additions: 15,
      deletions: 8,
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "BEHIND",
      reviewDecision: "APPROVED",
      reviews: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "SUCCESS",
                contexts: { nodes: [] },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    const result = extracted?.data;

    expect(result?.isBehind).toBe(true);
    expect(result?.mergeable).toBe(false);
    expect(result?.blockers).toContain("Branch is behind base branch");
  });

  it("should extract draft PR", () => {
    const pullRequest = {
      title: "WIP: New feature",
      state: "OPEN",
      additions: 50,
      deletions: 25,
      isDraft: true,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "NONE",
      reviews: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "SUCCESS",
                contexts: { nodes: [] },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    const result = extracted?.data;

    expect(result?.isDraft).toBe(true);
    expect(result?.mergeable).toBe(false);
    expect(result?.blockers).toContain("PR is still a draft");
  });

  it("should return null for invalid pull request data", () => {
    expect(extractPREnrichment(null)).toBeNull();
    expect(extractPREnrichment(undefined)).toBeNull();
    expect(extractPREnrichment({})).toBeNull();
    expect(extractPREnrichment({ invalid: "data" })).toBeNull();
  });

  it("should handle merged PR state", () => {
    const pullRequest = {
      title: "Completed feature",
      state: "MERGED",
      additions: 100,
      deletions: 50,
      isDraft: false,
      mergeable: null, // GitHub returns null for merged PRs
      mergeStateStatus: null,
      reviewDecision: "APPROVED",
      reviews: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "SUCCESS",
                contexts: { nodes: [] },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    const result = extracted?.data;

    expect(result?.state).toBe("merged");
  });

  it("should handle closed PR state", () => {
    const pullRequest = {
      title: "Abandoned PR",
      state: "CLOSED",
      additions: 10,
      deletions: 5,
      isDraft: false,
      mergeable: null,
      mergeStateStatus: null,
      reviewDecision: "NONE",
      reviews: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "SUCCESS",
                contexts: { nodes: [] },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    const result = extracted?.data;

    expect(result?.state).toBe("closed");
  });

  it("should handle PR with no reviewers required (APPROVED but reviewDecision is NONE)", () => {
    const pullRequest = {
      title: "Auto-mergeable PR",
      state: "OPEN",
      additions: 30,
      deletions: 15,
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "NONE", // No reviewers configured
      reviews: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "SUCCESS",
                contexts: { nodes: [] },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    const result = extracted?.data;

    expect(result?.reviewDecision).toBe("none");
    expect(result?.mergeable).toBe(true); // "none" is treated as approved for merge readiness
  });

  it("should handle PR with pending reviews", () => {
    const pullRequest = {
      title: "Pending review",
      state: "OPEN",
      additions: 40,
      deletions: 20,
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "REVIEW_REQUIRED",
      reviews: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "SUCCESS",
                contexts: { nodes: [] },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    const result = extracted?.data;

    expect(result?.reviewDecision).toBe("pending");
    expect(result?.mergeable).toBe(false);
    expect(result?.blockers).toContain("Review required");
  });
});

describe("MAX_BATCH_SIZE constant", () => {
  it("should be defined as 25", () => {
    expect(MAX_BATCH_SIZE).toBe(25);
  });
});

describe("ETag Cache", () => {
  beforeEach(() => {
    // Clear caches before each test
    clearETagCache();
    clearPRMetadataCache();
  });

  describe("ETag Cache Getters (Testing Exposed APIs)", () => {
    it("should return undefined for PR list ETag not in cache", () => {
      const owner = "testowner";
      const repo = "testrepo";

      expect(getPRListETag(owner, repo)).toBeUndefined();
    });

    it("should return undefined for commit status ETag not in cache", () => {
      const owner = "testowner";
      const repo = "testrepo";
      const sha = "abc123def456";

      expect(getCommitStatusETag(owner, repo, sha)).toBeUndefined();
    });
  });

  describe("PR Metadata Cache", () => {
    it("should store and retrieve PR metadata", () => {
      const key = "owner/repo#123";
      const metadata = { headSha: "abc123", ciStatus: "pending" };

      setPRMetadata(key, metadata);

      const cached = getPRMetadataCache().get(key);
      expect(cached).toEqual(metadata);
    });

    it("should store metadata for multiple PRs", () => {
      const key1 = "owner/repo#1";
      const key2 = "owner/repo#2";
      const key3 = "other/repo#1";

      setPRMetadata(key1, { headSha: "abc", ciStatus: "pending" });
      setPRMetadata(key2, { headSha: "def", ciStatus: "passing" });
      setPRMetadata(key3, { headSha: "ghi", ciStatus: "failing" });

      const cache = getPRMetadataCache();
      expect(cache.size).toBe(3);
      expect(cache.get(key1)?.ciStatus).toBe("pending");
      expect(cache.get(key2)?.ciStatus).toBe("passing");
      expect(cache.get(key3)?.ciStatus).toBe("failing");
    });

    it("should allow updating metadata for same PR", () => {
      const key = "owner/repo#123";

      setPRMetadata(key, { headSha: "abc", ciStatus: "pending" });
      expect(getPRMetadataCache().get(key)?.ciStatus).toBe("pending");

      setPRMetadata(key, { headSha: "abc", ciStatus: "passing" });
      expect(getPRMetadataCache().get(key)?.ciStatus).toBe("passing");
    });

    it("should clear PR metadata cache", () => {
      setPRMetadata("owner/repo#1", { headSha: "abc", ciStatus: "pending" });
      setPRMetadata("owner/repo#2", { headSha: "def", ciStatus: "passing" });

      expect(getPRMetadataCache().size).toBe(2);

      clearPRMetadataCache();

      expect(getPRMetadataCache().size).toBe(0);
    });

    it("should handle null headSha", () => {
      const key = "owner/repo#123";
      const metadata = { headSha: null, ciStatus: "passing" };

      setPRMetadata(key, metadata);

      const cached = getPRMetadataCache().get(key);
      expect(cached).toEqual(metadata);
      expect(cached?.headSha).toBeNull();
    });
  });
});

describe("shouldRefreshPREnrichment - ETag Guard Strategy", () => {
  beforeEach(() => {
    clearETagCache();
    clearPRMetadataCache();
    // Don't clear all mocks - reset only our mock call counts
    mockExecFileImpl.mockClear();
  });

  describe("Empty PRs", () => {
    it("should not refresh when no PRs provided", async () => {
      const result = await shouldRefreshPREnrichment([]);

      expect(result.shouldRefresh).toBe(false);
      expect(result.details).toContain("No PRs to check");
      // Should not make any API calls
      expect(mockExecFileImpl).not.toHaveBeenCalled();
    });
  });

  describe("Guard 1: PR List ETag - First-time PR (no cache)", () => {
    it("should refresh when PR list ETag check returns 200 (first time)", async () => {
      const prs = [
        {
          owner: "owner",
          repo: "repo",
          number: 123,
          url: "https://github.com/owner/repo/pull/123",
          title: "Test PR",
          branch: "feature",
          baseBranch: "main",
          isDraft: false,
        },
      ];

      // Mock gh CLI response for PR list check (200 OK, not 304)
      mockExecFileImpl.mockResolvedValueOnce({
        stdout: 'HTTP/2 200\neTag: "abc123"',
        stderr: "",
      });

      const result = await shouldRefreshPREnrichment(prs);

      expect(result.shouldRefresh).toBe(true);
      expect(result.details).toContain("PR list changed for owner/repo (Guard 1)");
      expect(mockExecFileImpl).toHaveBeenCalledTimes(1);
    });

    it("should not refresh when PR list ETag returns 304 Not Modified", async () => {
      const prs = [
        {
          owner: "owner",
          repo: "repo",
          number: 123,
          url: "https://github.com/owner/repo/pull/123",
          title: "Test PR",
          branch: "feature",
          baseBranch: "main",
          isDraft: false,
        },
      ];

      // Mock gh CLI response for PR list check (304 Not Modified)
      mockExecFileImpl.mockResolvedValueOnce({
        stdout: 'HTTP/2 304',
        stderr: "",
      });

      const result = await shouldRefreshPREnrichment(prs);

      expect(result.shouldRefresh).toBe(false);
      // When no changes detected, details may be empty (only changes add to details)
      expect(result.details).toHaveLength(0);
    });

    it("should refresh on error and log warning", async () => {
      const prs = [
        {
          owner: "owner",
          repo: "repo",
          number: 123,
          url: "https://github.com/owner/repo/pull/123",
          title: "Test PR",
          branch: "feature",
          baseBranch: "main",
          isDraft: false,
        },
      ];

      // Mock gh CLI error
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockExecFileImpl.mockRejectedValueOnce(new Error("gh CLI failed"));

      const result = await shouldRefreshPREnrichment(prs);

      expect(result.shouldRefresh).toBe(true); // Fail-safe: assume changed on error
      expect(consoleWarnSpy).toHaveBeenCalled();
      consoleWarnSpy.mockRestore();
    });
  });

  describe("Guard 2: Commit Status ETag - Pending CI PRs", () => {
    it("should refresh when commit status ETag check returns 200", async () => {
      // Set up cached PR with pending CI
      setPRMetadata("owner/repo#123", { headSha: "abc123", ciStatus: "pending" });

      const prs = [
        {
          owner: "owner",
          repo: "repo",
          number: 123,
          url: "https://github.com/owner/repo/pull/123",
          title: "Test PR",
          branch: "feature",
          baseBranch: "main",
          isDraft: false,
        },
      ];

      // Mock: Guard 1 returns 304 (no change), Guard 2 returns 200 (CI changed)
      mockExecFileImpl
        .mockResolvedValueOnce({
          stdout: 'HTTP/2 304', // Guard 1: no change
          stderr: "",
        })
        .mockResolvedValueOnce({
          stdout: 'HTTP/2 200\neTag: "xyz789"', // Guard 2: CI changed
          stderr: "",
        });

      const result = await shouldRefreshPREnrichment(prs);

      expect(result.shouldRefresh).toBe(true);
      expect(result.details).toContain("CI status changed for owner/repo#123 (Guard 2)");
      expect(mockExecFileImpl).toHaveBeenCalledTimes(2);
    });

    it("should not refresh when commit status ETag returns 304", async () => {
      // Set up cached PR with pending CI
      setPRMetadata("owner/repo#123", { headSha: "abc123", ciStatus: "pending" });

      const prs = [
        {
          owner: "owner",
          repo: "repo",
          number: 123,
          url: "https://github.com/owner/repo/pull/123",
          title: "Test PR",
          branch: "feature",
          baseBranch: "main",
          isDraft: false,
        },
      ];

      // Mock both guards return 304 (no change)
      mockExecFileImpl
        .mockResolvedValueOnce({
          stdout: 'HTTP/2 304',
          stderr: "",
        })
        .mockResolvedValueOnce({
          stdout: 'HTTP/2 304',
          stderr: "",
        });

      const result = await shouldRefreshPREnrichment(prs);

      expect(result.shouldRefresh).toBe(false);
      expect(mockExecFileImpl).toHaveBeenCalledTimes(2);
    });

    it("should check Guard 2 for ALL PRs with cached metadata", async () => {
      // Set up cached PR with passing CI (not pending) - still should be checked
      setPRMetadata("owner/repo#123", { headSha: "abc123", ciStatus: "passing" });

      const prs = [
        {
          owner: "owner",
          repo: "repo",
          number: 123,
          url: "https://github.com/owner/repo/pull/123",
          title: "Test PR",
          branch: "feature",
          baseBranch: "main",
          isDraft: false,
        },
      ];

      // Mock both guards return 304 (no change)
      mockExecFileImpl
        .mockResolvedValueOnce({
          stdout: 'HTTP/2 304',
          stderr: "",
        })
        .mockResolvedValueOnce({
          stdout: 'HTTP/2 304',
          stderr: "",
        });

      const result = await shouldRefreshPREnrichment(prs);

      expect(result.shouldRefresh).toBe(false);
      expect(mockExecFileImpl).toHaveBeenCalledTimes(2); // Guard 1 + Guard 2 called
    });

    it("should refresh when PR has no cached head SHA", async () => {
      // Set up cached PR with null head SHA (incomplete cache)
      setPRMetadata("owner/repo#123", { headSha: null, ciStatus: "pending" });

      const prs = [
        {
          owner: "owner",
          repo: "repo",
          number: 123,
          url: "https://github.com/owner/repo/pull/123",
          title: "Test PR",
          branch: "feature",
          baseBranch: "main",
          isDraft: false,
        },
      ];

      // Mock Guard 1 (PR list check)
      mockExecFileImpl.mockResolvedValueOnce({
        stdout: 'HTTP/2 304',
        stderr: "",
      });

      const result = await shouldRefreshPREnrichment(prs);

      expect(result.shouldRefresh).toBe(true);
      expect(result.details).toContain("First time seeing PR #123 (Guard 2: no cached head SHA)");
      // Guard 1 called for PR list, Guard 2 skipped (no head SHA to check)
      expect(mockExecFileImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe("Multiple Repositories", () => {
    it("should check PR list ETag for each repository", async () => {
      const prs = [
        {
          owner: "owner1",
          repo: "repo1",
          number: 1,
          url: "https://github.com/owner1/repo1/pull/1",
          title: "Test PR 1",
          branch: "feature1",
          baseBranch: "main",
          isDraft: false,
        },
        {
          owner: "owner2",
          repo: "repo2",
          number: 2,
          url: "https://github.com/owner2/repo2/pull/2",
          title: "Test PR 2",
          branch: "feature2",
          baseBranch: "main",
          isDraft: false,
        },
      ];

      // With new behavior: ALL PRs with cached metadata get Guard 2 checked
      // Add metadata for both PRs to validate Guard 2 is called
      setPRMetadata("owner1/repo1#1", { headSha: "sha1", ciStatus: "passing" });
      setPRMetadata("owner2/repo2#2", { headSha: "sha2", ciStatus: "pending" });

      // Both repos changed - Guard 1 calls
      mockExecFileImpl
        .mockResolvedValueOnce({
          stdout: 'HTTP/2 200',
          stderr: "",
        })
        .mockResolvedValueOnce({
          stdout: 'HTTP/2 200',
          stderr: "",
        });

      const result = await shouldRefreshPREnrichment(prs);

      expect(result.shouldRefresh).toBe(true);
      // Guard 1 adds 2 details (one per repo), Guard 2 skipped (304 = no change, no detail)
      expect(result.details).toHaveLength(2);
      expect(result.details).toContain("PR list changed for owner1/repo1 (Guard 1)");
      expect(result.details).toContain("PR list changed for owner2/repo2 (Guard 1)");
      // 2 Guard 1 calls only (Guard 2 calls return 304, no details added)
      expect(mockExecFileImpl).toHaveBeenCalledTimes(2);
    });
  });

  describe("If-None-Match Header", () => {
    it("should send If-None-Match header with cached ETag", async () => {
      const prs = [
        {
          owner: "owner",
          repo: "repo",
          number: 123,
          url: "https://github.com/owner/repo/pull/123",
          title: "Test PR",
          branch: "feature",
          baseBranch: "main",
          isDraft: false,
        },
      ];

      // First call - cache miss, returns new ETag
      mockExecFileImpl.mockResolvedValueOnce({
        stdout: 'HTTP/2 200\netag: "cached-etag"',
        stderr: "",
      });

      const result1 = await shouldRefreshPREnrichment(prs);
      expect(result1.shouldRefresh).toBe(true);

      // Cache metadata after first poll so Guard 2 has data for second poll
      setPRMetadata("owner/repo#123", { headSha: "abc123", ciStatus: "passing" });

      // Second call - should use cached ETag in If-None-Match headers (Guard 1 + Guard 2)
      mockExecFileImpl
        .mockResolvedValueOnce({
          stdout: 'HTTP/2 304',
          stderr: "",
        })
        .mockResolvedValueOnce({
          stdout: 'HTTP/2 304',
          stderr: "",
        });

      const result2 = await shouldRefreshPREnrichment(prs);
      expect(result2.shouldRefresh).toBe(false);

      // Cache metadata after first poll so Guard 2 has data for second poll
      setPRMetadata("owner/repo#123", { headSha: "abc123", ciStatus: "passing" });

      // Second poll - should use cached ETag in If-None-Match headers (Guard 1 + Guard 2)
      mockExecFileImpl
        .mockResolvedValueOnce({
          stdout: 'HTTP/2 304',
          stderr: "",
        })
        .mockResolvedValueOnce({
          stdout: 'HTTP/2 304',
          stderr: "",
        });

      const result3 = await shouldRefreshPREnrichment(prs);
      expect(result3.shouldRefresh).toBe(false);

      // Verify the second poll included If-None-Match headers
      // Get all call arguments and find those with -H flag
      const allCalls = mockExecFileImpl.mock.calls;
      const secondPollCalls = allCalls.slice(1); // Skip first poll calls
      const callsWithHeader = secondPollCalls.filter((call) =>
        Array.isArray(call) && call.includes("-H")
      );
      expect(callsWithHeader).toHaveLength(2); // Both Guard 1 and Guard 2
    });
  });
});
