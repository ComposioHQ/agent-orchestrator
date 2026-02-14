/**
 * Integration tests for the Linear tracker plugin.
 *
 * Requires one of:
 *   - LINEAR_API_KEY (direct Linear API access), or
 *   - COMPOSIO_API_KEY (via Composio SDK, optionally COMPOSIO_ENTITY_ID)
 * Plus:
 *   - LINEAR_TEAM_ID (team to create test issues in)
 *
 * When using Composio, cleanup (issue deletion) still requires LINEAR_API_KEY
 * since that uses a direct GraphQL call outside the plugin.
 *
 * Skipped automatically when prerequisites are missing.
 *
 * Each test run creates a real Linear issue, exercises the plugin methods
 * against it, and deletes it in cleanup. This validates that our GraphQL
 * queries, state mapping, and data parsing work against the real API —
 * not just against mocked responses.
 */

import { request } from "node:https";
import type { ProjectConfig } from "@agent-orchestrator/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import trackerLinear from "@agent-orchestrator/plugin-tracker-linear";

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

const LINEAR_API_KEY = process.env["LINEAR_API_KEY"];
const COMPOSIO_API_KEY = process.env["COMPOSIO_API_KEY"];
const LINEAR_TEAM_ID = process.env["LINEAR_TEAM_ID"];
const hasCredentials = Boolean(LINEAR_API_KEY || COMPOSIO_API_KEY);
const canRun = hasCredentials && Boolean(LINEAR_TEAM_ID);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Direct GraphQL call for test setup/cleanup.
 * Only available when LINEAR_API_KEY is set.
 */
function linearGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  if (!LINEAR_API_KEY) {
    throw new Error("linearGraphQL requires LINEAR_API_KEY");
  }
  const body = JSON.stringify({ query, variables });

  return new Promise<T>((resolve, reject) => {
    const url = new URL("https://api.linear.app/graphql");
    const req = request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: LINEAR_API_KEY,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf-8");
            const json = JSON.parse(text) as {
              data?: T;
              errors?: Array<{ message: string }>;
            };
            if (json.errors?.length) {
              reject(new Error(`Linear API error: ${json.errors[0].message}`));
              return;
            }
            resolve(json.data as T);
          } catch (err) {
            reject(err);
          }
        });
      },
    );

    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error("Linear API request timed out"));
    });

    req.on("error", (err) => reject(err));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)("tracker-linear (integration)", () => {
  const tracker = trackerLinear.create();

  const project: ProjectConfig = {
    name: "test-project",
    repo: "test-org/test-repo",
    path: "/tmp/test",
    defaultBranch: "main",
    sessionPrefix: "test",
    tracker: {
      plugin: "linear",
      teamId: LINEAR_TEAM_ID!,
    },
  };

  // Issue state tracked across tests (created in beforeAll, cleaned up in afterAll)
  let issueIdentifier: string; // e.g. "INT-1234"
  let issueUuid: string | undefined; // Linear internal UUID (needed for trash via direct API)

  // -------------------------------------------------------------------------
  // Setup — create a test issue
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    const result = await tracker.createIssue!(
      {
        title: `[AO Integration Test] ${new Date().toISOString()}`,
        description:
          "Automated integration test issue. Safe to delete if found lingering.",
        priority: 4, // Low
      },
      project,
    );

    issueIdentifier = result.id;

    // Resolve the UUID for cleanup — only possible with direct API key
    if (LINEAR_API_KEY) {
      const data = await linearGraphQL<{ issue: { id: string } }>(
        `query($id: String!) { issue(id: $id) { id } }`,
        { id: issueIdentifier },
      );
      issueUuid = data.issue.id;
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Cleanup — archive the test issue so it doesn't clutter the board.
  // With LINEAR_API_KEY we can trash it directly. With Composio-only we
  // close it via the plugin (can't trash through the plugin interface).
  // -------------------------------------------------------------------------

  afterAll(async () => {
    if (!issueIdentifier) return;

    try {
      if (issueUuid && LINEAR_API_KEY) {
        await linearGraphQL(
          `mutation($id: String!) {
            issueUpdate(id: $id, input: { trashed: true }) {
              success
            }
          }`,
          { id: issueUuid },
        );
      } else {
        // Composio-only: best-effort close via plugin
        await tracker.updateIssue!(
          issueIdentifier,
          { state: "closed" },
          project,
        );
      }
    } catch {
      // Best-effort cleanup
    }
  }, 15_000);

  // -------------------------------------------------------------------------
  // Test cases
  // -------------------------------------------------------------------------

  it("createIssue returns a well-shaped Issue", () => {
    // Validating the result captured in beforeAll
    expect(issueIdentifier).toBeDefined();
    expect(issueIdentifier).toMatch(/^[A-Z]+-\d+$/);
  });

  it("getIssue fetches the created issue with correct fields", async () => {
    const issue = await tracker.getIssue(issueIdentifier, project);

    expect(issue.id).toBe(issueIdentifier);
    expect(issue.title).toContain("[AO Integration Test]");
    expect(issue.description).toContain("Automated integration test");
    expect(issue.url).toMatch(/^https:\/\/linear\.app\//);
    expect(issue.state).toBe("open");
    expect(Array.isArray(issue.labels)).toBe(true);
    expect(issue.priority).toBe(4);
  });

  it("isCompleted returns false for an open issue", async () => {
    const completed = await tracker.isCompleted(issueIdentifier, project);
    expect(completed).toBe(false);
  });

  it("issueUrl returns a valid Linear URL", () => {
    const url = tracker.issueUrl(issueIdentifier, project);
    expect(url).toContain(issueIdentifier);
    expect(url).toMatch(/^https:\/\/linear\.app\//);
  });

  it("branchName returns conventional branch name", () => {
    const branch = tracker.branchName(issueIdentifier, project);
    expect(branch).toBe(`feat/${issueIdentifier}`);
  });

  it("generatePrompt includes issue details", async () => {
    const prompt = await tracker.generatePrompt(issueIdentifier, project);

    expect(prompt).toContain(issueIdentifier);
    expect(prompt).toContain("[AO Integration Test]");
    expect(prompt).toContain("Priority: Low");
    expect(prompt).toContain("implement the changes");
  });

  it("listIssues includes the created issue", async () => {
    const issues = await tracker.listIssues!(
      { state: "open", limit: 50 },
      project,
    );

    const found = issues.find((i) => i.id === issueIdentifier);
    expect(found).toBeDefined();
    expect(found!.title).toContain("[AO Integration Test]");
  });

  it("updateIssue adds a comment", async () => {
    await tracker.updateIssue!(
      issueIdentifier,
      { comment: "Integration test comment" },
      project,
    );

    // Verify the comment was added — use direct API if available,
    // otherwise trust the plugin didn't throw
    if (LINEAR_API_KEY) {
      const data = await linearGraphQL<{
        issue: { comments: { nodes: Array<{ body: string }> } };
      }>(
        `query($id: String!) {
          issue(id: $id) {
            comments { nodes { body } }
          }
        }`,
        { id: issueIdentifier },
      );

      const commentBodies = data.issue.comments.nodes.map((c) => c.body);
      expect(commentBodies).toContain("Integration test comment");
    }
  });

  it("updateIssue closes the issue and isCompleted reflects it", async () => {
    await tracker.updateIssue!(
      issueIdentifier,
      { state: "closed" },
      project,
    );

    const completed = await tracker.isCompleted(issueIdentifier, project);
    expect(completed).toBe(true);

    const issue = await tracker.getIssue(issueIdentifier, project);
    expect(issue.state).toBe("closed");
  });

  it("updateIssue reopens the issue", async () => {
    await tracker.updateIssue!(
      issueIdentifier,
      { state: "open" },
      project,
    );

    const completed = await tracker.isCompleted(issueIdentifier, project);
    expect(completed).toBe(false);

    const issue = await tracker.getIssue(issueIdentifier, project);
    expect(issue.state).toBe("open");
  });
});
