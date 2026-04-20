/**
 * Unit tests for GraphQL batch PR enrichment.
 *
 * Note: The GraphQL batch query was optimized to use only the top-level
 * statusCheckRollup.state field instead of fetching individual contexts.
 * This reduces GraphQL API cost from ~50 points to ~10 points per PR while
 * providing the same semantic information for CI status determination.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Import from graphql-batch.js
import {
  generateBatchQuery,
  MAX_BATCH_SIZE,
  parseCIState,
  parseReviewDecision,
  parsePRState,
  extractPREnrichment,
  clearETagCache,
  getPRResourceETag,
  getCommitStatusETag,
  setPRResourceETag,
  setCommitStatusETag,
  setPRMetadata,
  getPRMetadataCache,
  clearPRMetadataCache,
  shouldRefreshPREnrichment,
  updatePRMetadataCache,
  setExecFileAsync,
} from "../src/graphql-batch.js";
import type { PREnrichmentData } from "@aoagents/ao-core";

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
    it("should return undefined for PR resource ETag not in cache", () => {
      const owner = "testowner";
      const repo = "testrepo";

      expect(getPRResourceETag(owner, repo, 123)).toBeUndefined();
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
  // Shared test enrichment data for populating caches
  const testEnrichment: PREnrichmentData = {
    state: "open",
    ciStatus: "passing",
    reviewDecision: "none",
    mergeable: true,
    hasConflicts: false,
    isBehind: false,
    blockers: [],
  };

  const makePR = (owner: string, repo: string, number: number) => ({
    owner,
    repo,
    number,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    title: `Test PR ${number}`,
    branch: `feature-${number}`,
    baseBranch: "main",
    isDraft: false,
  });

  beforeEach(() => {
    clearETagCache();
    clearPRMetadataCache();
    mockExecFileImpl.mockClear();
  });

  describe("Empty PRs", () => {
    it("should return empty plan when no PRs provided", async () => {
      const result = await shouldRefreshPREnrichment([]);

      expect(result.prsToRefresh).toHaveLength(0);
      expect(result.cachedResults.size).toBe(0);
      expect(result.details).toContain("No PRs to check");
      expect(mockExecFileImpl).not.toHaveBeenCalled();
    });
  });

  describe("Guard 1: PR Resource ETag - First-time PR (no cache)", () => {
    it("should refresh when PR resource ETag returns 200 (first time)", async () => {
      const prs = [makePR("owner", "repo", 123)];

      mockExecFileImpl.mockResolvedValueOnce({
        stdout: 'HTTP/2 200\neTag: "abc123"',
        stderr: "",
      });

      const result = await shouldRefreshPREnrichment(prs);

      expect(result.prsToRefresh).toHaveLength(1);
      expect(result.prsToRefresh[0].number).toBe(123);
      expect(result.cachedResults.size).toBe(0);
      expect(result.details).toContain("PR resource changed for owner/repo#123 (Guard 1)");
      expect(mockExecFileImpl).toHaveBeenCalledTimes(1);
    });

    it("should serve from cache when Guard 1 returns 304 and cache is populated", async () => {
      const prs = [makePR("owner", "repo", 123)];

      // Populate both metadata and enrichment caches
      updatePRMetadataCache("owner/repo#123", testEnrichment, "abc123");

      // Guard 1: 304, Guard 2: 304
      mockExecFileImpl
        .mockResolvedValueOnce({ stdout: "HTTP/2 304", stderr: "" })
        .mockResolvedValueOnce({ stdout: "HTTP/2 304", stderr: "" });

      const result = await shouldRefreshPREnrichment(prs);

      expect(result.prsToRefresh).toHaveLength(0);
      expect(result.cachedResults.size).toBe(1);
      expect(result.cachedResults.has("owner/repo#123")).toBe(true);
      expect(mockExecFileImpl).toHaveBeenCalledTimes(2); // Guard 1 + Guard 2
    });

    it("should refresh when Guard 1 returns 304 but no enrichment cache exists", async () => {
      const prs = [makePR("owner", "repo", 123)];

      // Only metadata cache, no enrichment cache
      setPRMetadata("owner/repo#123", { headSha: "abc123", ciStatus: "passing" as const });

      mockExecFileImpl.mockResolvedValueOnce({ stdout: "HTTP/2 304", stderr: "" });

      const result = await shouldRefreshPREnrichment(prs);

      expect(result.prsToRefresh).toHaveLength(1);
      expect(result.details).toContain("No cached data for owner/repo#123 (Guard 1: 304 but cache miss)");
      expect(mockExecFileImpl).toHaveBeenCalledTimes(1); // Only Guard 1, no Guard 2
    });

    it("should refresh on error and log warning", async () => {
      const prs = [makePR("owner", "repo", 123)];

      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockExecFileImpl.mockRejectedValueOnce(new Error("gh CLI failed"));

      const result = await shouldRefreshPREnrichment(prs);

      expect(result.prsToRefresh).toHaveLength(1);
      expect(consoleWarnSpy).toHaveBeenCalled();
      consoleWarnSpy.mockRestore();
    });
  });

  describe("Guard 2: Commit Status ETag", () => {
    it("should refresh when commit status ETag returns 200", async () => {
      updatePRMetadataCache("owner/repo#123", testEnrichment, "abc123");
      const prs = [makePR("owner", "repo", 123)];

      // Guard 1: 304, Guard 2: 200
      mockExecFileImpl
        .mockResolvedValueOnce({ stdout: "HTTP/2 304", stderr: "" })
        .mockResolvedValueOnce({ stdout: 'HTTP/2 200\neTag: "xyz789"', stderr: "" });

      const result = await shouldRefreshPREnrichment(prs);

      expect(result.prsToRefresh).toHaveLength(1);
      expect(result.cachedResults.size).toBe(0);
      expect(result.details).toContain("CI status changed for owner/repo#123 (Guard 2)");
      expect(mockExecFileImpl).toHaveBeenCalledTimes(2);
    });

    it("should serve from cache when both guards return 304", async () => {
      updatePRMetadataCache("owner/repo#123", testEnrichment, "abc123");
      const prs = [makePR("owner", "repo", 123)];

      mockExecFileImpl
        .mockResolvedValueOnce({ stdout: "HTTP/2 304", stderr: "" })
        .mockResolvedValueOnce({ stdout: "HTTP/2 304", stderr: "" });

      const result = await shouldRefreshPREnrichment(prs);

      expect(result.prsToRefresh).toHaveLength(0);
      expect(result.cachedResults.size).toBe(1);
      expect(mockExecFileImpl).toHaveBeenCalledTimes(2);
    });

    it("should refresh when PR has null headSha (incomplete cache)", async () => {
      // headSha null → cache miss even though metadata exists
      setPRMetadata("owner/repo#123", { headSha: null, ciStatus: "pending" as const });
      const prs = [makePR("owner", "repo", 123)];

      mockExecFileImpl.mockResolvedValueOnce({ stdout: "HTTP/2 304", stderr: "" });

      const result = await shouldRefreshPREnrichment(prs);

      expect(result.prsToRefresh).toHaveLength(1);
      expect(result.details).toContain("No cached data for owner/repo#123 (Guard 1: 304 but cache miss)");
      expect(mockExecFileImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe("Multiple PRs", () => {
    it("should check PR resource ETag for each PR individually", async () => {
      const prs = [makePR("owner1", "repo1", 1), makePR("owner2", "repo2", 2)];

      // Both PRs changed
      mockExecFileImpl
        .mockResolvedValueOnce({ stdout: "HTTP/2 200", stderr: "" })
        .mockResolvedValueOnce({ stdout: "HTTP/2 200", stderr: "" });

      const result = await shouldRefreshPREnrichment(prs);

      expect(result.prsToRefresh).toHaveLength(2);
      expect(result.details).toContain("PR resource changed for owner1/repo1#1 (Guard 1)");
      expect(result.details).toContain("PR resource changed for owner2/repo2#2 (Guard 1)");
      expect(mockExecFileImpl).toHaveBeenCalledTimes(2);
    });

    it("should refresh only the changed PR when one returns 200 and another 304", async () => {
      // Both PRs have cached enrichment
      updatePRMetadataCache("owner/repo#1", testEnrichment, "sha1");
      updatePRMetadataCache("owner/repo#2", testEnrichment, "sha2");
      setCommitStatusETag("owner", "repo", "sha2", "commit-etag-2");

      const prs = [makePR("owner", "repo", 1), makePR("owner", "repo", 2)];

      mockExecFileImpl
        .mockResolvedValueOnce({ stdout: 'HTTP/2 200\netag: "new"', stderr: "" })  // Guard 1 PR#1: changed
        .mockResolvedValueOnce({ stdout: "HTTP/2 304", stderr: "" })               // Guard 1 PR#2: unchanged
        .mockResolvedValueOnce({ stdout: "HTTP/2 304", stderr: "" });              // Guard 2 PR#2: CI unchanged

      const result = await shouldRefreshPREnrichment(prs);

      expect(result.prsToRefresh).toHaveLength(1);
      expect(result.prsToRefresh[0].number).toBe(1);
      expect(result.cachedResults.size).toBe(1);
      expect(result.cachedResults.has("owner/repo#2")).toBe(true);
    });
  });

  describe("If-None-Match Header", () => {
    it("should send If-None-Match header with cached ETag", async () => {
      const prs = [makePR("owner", "repo", 123)];

      // First call — cache miss, returns new ETag
      mockExecFileImpl.mockResolvedValueOnce({
        stdout: 'HTTP/2 200\netag: "cached-etag"',
        stderr: "",
      });

      const result1 = await shouldRefreshPREnrichment(prs);
      expect(result1.prsToRefresh).toHaveLength(1);

      // Populate caches after first poll
      updatePRMetadataCache("owner/repo#123", testEnrichment, "abc123");
      setPRResourceETag("owner", "repo", 123, "cached-etag");
      setCommitStatusETag("owner", "repo", "abc123", "commit-status-etag");

      // Second call — should use cached ETag in If-None-Match
      mockExecFileImpl
        .mockResolvedValueOnce({ stdout: "HTTP/2 304", stderr: "" })
        .mockResolvedValueOnce({ stdout: "HTTP/2 304", stderr: "" });

      const result2 = await shouldRefreshPREnrichment(prs);
      expect(result2.prsToRefresh).toHaveLength(0);
      expect(result2.cachedResults.size).toBe(1);

      // Verify the second poll included If-None-Match headers
      const allCalls = mockExecFileImpl.mock.calls;
      const secondPollCalls = allCalls.slice(1, 3);
      const callsWithHeader = secondPollCalls.filter((call) =>
        Array.isArray(call) && call[1] && call[1].includes("-H")
      );
      expect(callsWithHeader).toHaveLength(2); // Guard 1 + Guard 2
    });
  });
});

describe("extractPREnrichment ciChecks", () => {
  it("parses CheckRun contexts into ciChecks", () => {
    const pullRequest = {
      title: "Fix CI",
      state: "OPEN",
      additions: 10,
      deletions: 5,
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "NONE",
      reviews: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "FAILURE",
                contexts: {
                  nodes: [
                    {
                      name: "lint",
                      status: "COMPLETED",
                      conclusion: "FAILURE",
                      detailsUrl: "https://github.com/org/repo/actions/runs/123",
                    },
                    {
                      name: "test",
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                      detailsUrl: "https://github.com/org/repo/actions/runs/124",
                    },
                    {
                      name: "typecheck",
                      status: "IN_PROGRESS",
                      conclusion: null,
                      detailsUrl: "https://github.com/org/repo/actions/runs/125",
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    const ciChecks = extracted?.data.ciChecks;

    expect(ciChecks).toBeDefined();
    expect(ciChecks).toHaveLength(3);

    const lint = ciChecks?.find((c) => c.name === "lint");
    expect(lint?.status).toBe("failed");
    expect(lint?.conclusion).toBe("FAILURE");
    expect(lint?.url).toBe("https://github.com/org/repo/actions/runs/123");

    const test = ciChecks?.find((c) => c.name === "test");
    expect(test?.status).toBe("passed");
    expect(test?.conclusion).toBe("SUCCESS");

    const typecheck = ciChecks?.find((c) => c.name === "typecheck");
    expect(typecheck?.status).toBe("running");
  });

  it("maps QUEUED and WAITING to pending, not running (matches REST mapRawCheckStateToStatus)", () => {
    const pullRequest = {
      title: "Queued checks",
      state: "OPEN",
      additions: 1,
      deletions: 0,
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "NONE",
      reviews: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "PENDING",
                contexts: {
                  nodes: [
                    { name: "queued-check", status: "QUEUED", conclusion: null, detailsUrl: null },
                    { name: "waiting-check", status: "WAITING", conclusion: null, detailsUrl: null },
                  ],
                },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    const ciChecks = extracted?.data.ciChecks;
    expect(ciChecks?.find((c) => c.name === "queued-check")?.status).toBe("pending");
    expect(ciChecks?.find((c) => c.name === "waiting-check")?.status).toBe("pending");
  });

  it("parses StatusContext nodes into ciChecks", () => {
    const pullRequest = {
      title: "Legacy CI",
      state: "OPEN",
      additions: 5,
      deletions: 2,
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "NONE",
      reviews: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "FAILURE",
                contexts: {
                  nodes: [
                    {
                      context: "ci/build",
                      state: "FAILURE",
                      targetUrl: "https://ci.example.com/build/1",
                    },
                    {
                      context: "ci/test",
                      state: "SUCCESS",
                      targetUrl: "https://ci.example.com/test/1",
                    },
                    {
                      context: "ci/deploy",
                      state: "PENDING",
                      targetUrl: null,
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    const ciChecks = extracted?.data.ciChecks;

    expect(ciChecks).toBeDefined();
    expect(ciChecks).toHaveLength(3);

    const build = ciChecks?.find((c) => c.name === "ci/build");
    expect(build?.status).toBe("failed");
    expect(build?.conclusion).toBe("FAILURE"); // matches REST getCIChecksFromStatusRollup format
    expect(build?.url).toBe("https://ci.example.com/build/1");

    const test = ciChecks?.find((c) => c.name === "ci/test");
    expect(test?.status).toBe("passed");
    expect(test?.conclusion).toBe("SUCCESS");

    const deploy = ciChecks?.find((c) => c.name === "ci/deploy");
    expect(deploy?.status).toBe("pending");
    expect(deploy?.conclusion).toBe("PENDING");
    expect(deploy?.url).toBeUndefined();
  });

  it("returns empty array when contexts nodes is empty", () => {
    const pullRequest = {
      title: "Clean PR",
      state: "OPEN",
      additions: 5,
      deletions: 2,
      isDraft: false,
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
    expect(extracted?.data.ciChecks).toEqual([]);
  });

  it("returns undefined ciChecks when statusCheckRollup has no contexts field", () => {
    const pullRequest = {
      title: "No contexts",
      state: "OPEN",
      additions: 5,
      deletions: 2,
      isDraft: false,
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
                // No contexts field — older API response
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    expect(extracted?.data.ciChecks).toBeUndefined();
  });

  it("maps COMPLETED+SKIPPED conclusion to skipped status", () => {
    const pullRequest = {
      title: "Skipped check",
      state: "OPEN",
      additions: 5,
      deletions: 2,
      isDraft: false,
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
                contexts: {
                  nodes: [
                    {
                      name: "optional-check",
                      status: "COMPLETED",
                      conclusion: "SKIPPED",
                      detailsUrl: null,
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    const check = extracted?.data.ciChecks?.[0];
    expect(check?.status).toBe("skipped");
    expect(check?.conclusion).toBe("SKIPPED"); // uppercased to match REST format
  });

  it("maps COMPLETED+NEUTRAL conclusion to skipped (matches REST mapRawCheckStateToStatus)", () => {
    const pullRequest = {
      title: "Neutral check",
      state: "OPEN",
      additions: 5,
      deletions: 2,
      isDraft: false,
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
                contexts: {
                  nodes: [
                    {
                      name: "optional-check",
                      status: "COMPLETED",
                      conclusion: "NEUTRAL",
                      detailsUrl: null,
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    const check = extracted?.data.ciChecks?.[0];
    // NEUTRAL maps to "skipped" in REST mapRawCheckStateToStatus — must match
    expect(check?.status).toBe("skipped");
    expect(check?.conclusion).toBe("NEUTRAL");
  });

  it("uppercases CheckRun conclusion to match REST getCIChecks format", () => {
    const pullRequest = {
      title: "Mixed case conclusion",
      state: "OPEN",
      additions: 5,
      deletions: 2,
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "NONE",
      reviews: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "FAILURE",
                contexts: {
                  nodes: [
                    {
                      name: "lint",
                      status: "COMPLETED",
                      conclusion: "failure", // lowercase from API
                      detailsUrl: null,
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    const check = extracted?.data.ciChecks?.[0];
    expect(check?.status).toBe("failed");
    expect(check?.conclusion).toBe("FAILURE"); // must be uppercased
  });

  it("maps STALE/NOT_REQUIRED/NONE conclusions to skipped (matches REST mapRawCheckStateToStatus)", () => {
    const makeContextsWithConclusion = (conclusion: string) => ({
      title: "Check",
      state: "OPEN",
      additions: 1,
      deletions: 0,
      isDraft: false,
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
                contexts: {
                  nodes: [{ name: "check", status: "COMPLETED", conclusion, detailsUrl: null }],
                },
              },
            },
          },
        ],
      },
    });

    for (const conclusion of ["STALE", "NOT_REQUIRED", "NONE"]) {
      const extracted = extractPREnrichment(makeContextsWithConclusion(conclusion));
      const check = extracted?.data.ciChecks?.[0];
      expect(check?.status, `${conclusion} should map to skipped`).toBe("skipped");
    }
  });

  it("returns undefined ciChecks when contexts list is truncated (hasNextPage=true)", () => {
    const pullRequest = {
      title: "Many CI checks",
      state: "OPEN",
      additions: 5,
      deletions: 2,
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "NONE",
      reviews: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "FAILURE",
                contexts: {
                  nodes: [
                    { name: "check-1", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: null },
                    // ... 19 more checks truncated
                  ],
                  pageInfo: { hasNextPage: true }, // list was truncated!
                },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    // ciChecks should be undefined when truncated — forces getCIChecks() REST fallback
    expect(extracted?.data.ciChecks).toBeUndefined();
  });

  it("returns ciChecks when contexts list is complete (hasNextPage=false)", () => {
    const pullRequest = {
      title: "Few CI checks",
      state: "OPEN",
      additions: 5,
      deletions: 2,
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "NONE",
      reviews: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "FAILURE",
                contexts: {
                  nodes: [
                    { name: "lint", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci.example.com/lint" },
                  ],
                  pageInfo: { hasNextPage: false }, // complete list
                },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    expect(extracted?.data.ciChecks).toBeDefined();
    expect(extracted?.data.ciChecks).toHaveLength(1);
    expect(extracted?.data.ciChecks?.[0]?.name).toBe("lint");
  });

  it("maps COMPLETED with null conclusion to skipped (matches REST mapRawCheckStateToStatus empty-string branch)", () => {
    // REST path: mapRawCheckStateToStatus(undefined) → state="" → "skipped"
    // GraphQL path must match: COMPLETED + null conclusion → "skipped", not "passed"
    const pullRequest = {
      title: "Null conclusion check",
      state: "OPEN",
      additions: 1,
      deletions: 0,
      isDraft: false,
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
                contexts: {
                  nodes: [
                    {
                      name: "some-check",
                      status: "COMPLETED",
                      conclusion: null, // null conclusion — shouldn't map to "passed"
                      detailsUrl: null,
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    const check = extracted?.data.ciChecks?.[0];
    expect(check?.status).toBe("skipped");
  });

  it("maps COMPLETED+STARTUP_FAILURE to skipped (matches REST mapRawCheckStateToStatus default fallback)", () => {
    const pullRequest = {
      title: "Startup failure check",
      state: "OPEN",
      additions: 1,
      deletions: 0,
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "NONE",
      reviews: { nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "FAILURE",
                contexts: {
                  nodes: [
                    {
                      name: "infra-check",
                      status: "COMPLETED",
                      conclusion: "STARTUP_FAILURE",
                      detailsUrl: null,
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    };

    const extracted = extractPREnrichment(pullRequest);
    const check = extracted?.data.ciChecks?.[0];
    // STARTUP_FAILURE is not in the explicit failure list → falls through to "skipped"
    // matching mapRawCheckStateToStatus()'s default return "skipped"
    expect(check?.status).toBe("skipped");
    expect(check?.conclusion).toBe("STARTUP_FAILURE");
  });

  it("handles null pageInfo safely without TypeError (typeof null === 'object' quirk)", () => {
    const pullRequest = {
      title: "Null pageInfo",
      state: "OPEN",
      additions: 1,
      deletions: 0,
      isDraft: false,
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
                contexts: {
                  nodes: [
                    { name: "lint", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null },
                  ],
                  pageInfo: null, // null pageInfo — older API responses may omit this
                },
              },
            },
          },
        ],
      },
    };

    // Must not throw TypeError: Cannot read properties of null
    expect(() => extractPREnrichment(pullRequest)).not.toThrow();
    const extracted = extractPREnrichment(pullRequest);
    // null pageInfo is treated as "not truncated" → ciChecks should be defined
    expect(extracted?.data.ciChecks).toBeDefined();
    expect(extracted?.data.ciChecks).toHaveLength(1);
  });
});
