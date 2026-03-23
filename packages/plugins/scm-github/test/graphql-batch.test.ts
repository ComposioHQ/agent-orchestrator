/**
 * Unit tests for GraphQL batch PR enrichment.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  generateBatchQuery,
  MAX_BATCH_SIZE,
  parseCIState,
  parseReviewDecision,
  parsePRState,
  extractPREnrichment,
} from "../src/graphql-batch.js";

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

    expect(query).toContain("query BatchPRs($pr0Owner: String!, $pr0Name: String!, $pr0Number: String!)");
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

    expect(query).toBe("query BatchPRs() {\n      \n    }");
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
      state: "PENDING",
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

    const result = extractPREnrichment("test/repo#1", pullRequest);

    expect(result).not.toBeNull();
    expect(result?.state).toBe("open");
    expect(result?.ciStatus).toBe("passing");
    expect(result?.reviewDecision).toBe("approved");
    expect(result?.mergeable).toBe(true);
    expect(result?.title).toBe("Add new feature");
    expect(result?.additions).toBe(100);
    expect(result?.deletions).toBe(50);
    expect(result?.isDraft).toBe(false);
    expect(result?.hasConflicts).toBe(false);
    expect(result?.isBehind).toBe(false);
    expect(result?.blockers).toEqual([]);
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

    const result = extractPREnrichment("test/repo#2", pullRequest);

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

    const result = extractPREnrichment("test/repo#3", pullRequest);

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

    const result = extractPREnrichment("test/repo#4", pullRequest);

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

    const result = extractPREnrichment("test/repo#5", pullRequest);

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

    const result = extractPREnrichment("test/repo#6", pullRequest);

    expect(result?.isDraft).toBe(true);
    expect(result?.mergeable).toBe(false);
    expect(result?.blockers).toContain("PR is still a draft");
  });

  it("should return null for invalid pull request data", () => {
    expect(extractPREnrichment("test/repo#7", null)).toBeNull();
    expect(extractPREnrichment("test/repo#8", undefined)).toBeNull();
    expect(extractPREnrichment("test/repo#9", {})).toBeNull();
    expect(extractPREnrichment("test/repo#10", { invalid: "data" })).toBeNull();
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

    const result = extractPREnrichment("test/repo#11", pullRequest);

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

    const result = extractPREnrichment("test/repo#12", pullRequest);

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

    const result = extractPREnrichment("test/repo#13", pullRequest);

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

    const result = extractPREnrichment("test/repo#14", pullRequest);

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
