/**
 * Integration tests for the Jira tracker plugin.
 *
 * Requires one of:
 *   - JIRA_HOST + JIRA_EMAIL + JIRA_API_TOKEN (direct Jira API access), or
 *   - COMPOSIO_API_KEY + JIRA_HOST (via Composio SDK, optionally COMPOSIO_ENTITY_ID)
 * Plus:
 *   - JIRA_PROJECT_KEY (project to create test issues in, e.g. "PROJ")
 *
 * When using Composio, cleanup (issue deletion) still requires direct API
 * credentials since deletion uses a direct REST call outside the plugin.
 *
 * Skipped automatically when prerequisites are missing.
 *
 * Each test run creates a real Jira issue, exercises the plugin methods
 * against it, and deletes it in cleanup. This validates that our API
 * calls, state mapping, and data parsing work against the real API —
 * not just against mocked responses.
 */

import { request } from "node:https";
import type { ProjectConfig } from "@composio/ao-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import trackerJira from "@composio/ao-plugin-tracker-jira";
import { pollUntilEqual } from "./helpers/polling.js";

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

const JIRA_HOST = process.env["JIRA_HOST"];
const JIRA_EMAIL = process.env["JIRA_EMAIL"];
const JIRA_API_TOKEN = process.env["JIRA_API_TOKEN"];
const COMPOSIO_API_KEY = process.env["COMPOSIO_API_KEY"];
const JIRA_PROJECT_KEY = process.env["JIRA_PROJECT_KEY"];

const hasDirectCredentials = Boolean(JIRA_HOST && JIRA_EMAIL && JIRA_API_TOKEN);
const hasComposioCredentials = Boolean(COMPOSIO_API_KEY && JIRA_HOST);
const hasCredentials = hasDirectCredentials || hasComposioCredentials;
const canRun = hasCredentials && Boolean(JIRA_PROJECT_KEY);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Direct Jira REST API call for test setup/cleanup.
 * Only available when direct credentials are set.
 */
function jiraApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!JIRA_HOST || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error("jiraApi requires JIRA_HOST, JIRA_EMAIL, and JIRA_API_TOKEN");
  }
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

  return new Promise<T>((resolve, reject) => {
    const req = request(
      {
        hostname: JIRA_HOST,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Basic ${auth}`,
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf-8");
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(
                new Error(
                  `Jira API ${method} ${path} returned HTTP ${status}: ${text.slice(0, 200)}`,
                ),
              );
              return;
            }
            if (!text || text.trim() === "") {
              resolve(undefined as T);
              return;
            }
            resolve(JSON.parse(text) as T);
          } catch (err) {
            reject(err);
          }
        });
      },
    );

    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error("Jira API request timed out"));
    });

    req.on("error", (err) => reject(err));
    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)("tracker-jira (integration)", () => {
  // Auto-detects transport from env: COMPOSIO_API_KEY → Composio, else direct
  const tracker = trackerJira.create();

  const project: ProjectConfig = {
    name: "test-project",
    repo: "test-org/test-repo",
    path: "/tmp/test",
    defaultBranch: "main",
    sessionPrefix: "test",
    tracker: {
      plugin: "jira",
      projectKey: JIRA_PROJECT_KEY!,
      host: JIRA_HOST!,
    },
  };

  // Issue state tracked across tests (created in beforeAll, cleaned up in afterAll)
  let issueKey: string; // e.g. "PROJ-123"

  // -------------------------------------------------------------------------
  // Setup — create a test issue
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    const result = await tracker.createIssue!(
      {
        title: `[AO Integration Test] ${new Date().toISOString()}`,
        description: "Automated integration test issue. Safe to delete if found lingering.",
        priority: 4, // Low
      },
      project,
    );

    issueKey = result.id;
  }, 30_000);

  // -------------------------------------------------------------------------
  // Cleanup — delete the test issue.
  // With direct credentials we can delete it directly. With Composio-only we
  // close it via the plugin (can't delete through the plugin interface).
  // -------------------------------------------------------------------------

  afterAll(async () => {
    if (!issueKey) return;

    try {
      if (hasDirectCredentials) {
        await jiraApi("DELETE", `/rest/api/3/issue/${encodeURIComponent(issueKey)}`);
      } else {
        // Composio-only: best-effort close via plugin
        await tracker.updateIssue!(issueKey, { state: "closed" }, project);
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
    expect(issueKey).toBeDefined();
    expect(issueKey).toMatch(/^[A-Z][A-Z0-9_]+-\d+$/);
  });

  it("getIssue fetches the created issue with correct fields", async () => {
    const issue = await tracker.getIssue(issueKey, project);

    expect(issue.id).toBe(issueKey);
    expect(issue.title).toContain("[AO Integration Test]");
    expect(issue.description).toContain("Automated integration test");
    expect(issue.url).toContain(issueKey);
    expect(issue.state).toBe("open");
    expect(Array.isArray(issue.labels)).toBe(true);
  });

  it("isCompleted returns false for an open issue", async () => {
    const completed = await tracker.isCompleted(issueKey, project);
    expect(completed).toBe(false);
  });

  it("issueUrl returns a valid Jira URL", () => {
    const url = tracker.issueUrl(issueKey, project);
    expect(url).toContain(issueKey);
    expect(url).toMatch(/^https:\/\/.+\/browse\//);
  });

  it("issueLabel extracts the key from a Jira URL", () => {
    const url = tracker.issueUrl(issueKey, project);
    const label = tracker.issueLabel!(url, project);
    expect(label).toBe(issueKey);
  });

  it("branchName returns conventional branch name", () => {
    const branch = tracker.branchName(issueKey, project);
    expect(branch).toBe(`feat/${issueKey}`);
  });

  it("generatePrompt includes issue details", async () => {
    const prompt = await tracker.generatePrompt(issueKey, project);

    expect(prompt).toContain(issueKey);
    expect(prompt).toContain("[AO Integration Test]");
    expect(prompt).toContain("implement the changes");
  });

  it("listIssues includes the created issue", async () => {
    const issues = await tracker.listIssues!({ state: "open", limit: 50 }, project);

    const found = issues.find((i: { id: string }) => i.id === issueKey);
    expect(found).toBeDefined();
    expect(found!.title).toContain("[AO Integration Test]");
  });

  it("updateIssue adds a comment", async () => {
    await tracker.updateIssue!(issueKey, { comment: "Integration test comment" }, project);

    // Verify the comment was added — use direct API if available,
    // otherwise trust the plugin didn't throw
    if (hasDirectCredentials) {
      const data = await jiraApi<{
        comments: Array<{ body: unknown }>;
      }>("GET", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`);

      const commentBodies = data.comments.map((c) => {
        // Comments use ADF format — extract text from the first paragraph
        const body = c.body as { content?: Array<{ content?: Array<{ text?: string }> }> };
        return body?.content?.[0]?.content?.[0]?.text ?? "";
      });
      expect(commentBodies).toContain("Integration test comment");
    }
  });

  it("updateIssue closes the issue and isCompleted reflects it", async () => {
    await tracker.updateIssue!(issueKey, { state: "closed" }, project);

    // Jira API may have eventual consistency — poll until the state propagates
    const completed = await pollUntilEqual(() => tracker.isCompleted(issueKey, project), true, {
      timeoutMs: 5_000,
      intervalMs: 500,
    });
    expect(completed).toBe(true);

    const issue = await tracker.getIssue(issueKey, project);
    expect(issue.state).toBe("closed");
  });

  it("updateIssue reopens the issue", async () => {
    await tracker.updateIssue!(issueKey, { state: "open" }, project);

    // Jira API may have eventual consistency — poll until the state propagates
    const completed = await pollUntilEqual(() => tracker.isCompleted(issueKey, project), false, {
      timeoutMs: 5_000,
      intervalMs: 500,
    });
    expect(completed).toBe(false);

    const issue = await tracker.getIssue(issueKey, project);
    expect(issue.state).toBe("open");
  });
});
