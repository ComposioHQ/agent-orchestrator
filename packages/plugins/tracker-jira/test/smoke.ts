/**
 * Smoke test — hit real Jira API with env credentials.
 *
 * Direct transport:
 *   JIRA_HOST=... JIRA_EMAIL=... JIRA_API_TOKEN=... npx tsx test/smoke.ts <ISSUE-KEY>
 *
 * Composio transport:
 *   JIRA_HOST=... COMPOSIO_API_KEY=... npx tsx test/smoke.ts <ISSUE-KEY>
 */

import { create } from "../src/index.js";
import type { ProjectConfig } from "@composio/ao-core";

const issueKey = process.argv[2];
if (!issueKey) {
  console.error("Usage: npx tsx test/smoke.ts <ISSUE-KEY>");
  process.exit(1);
}

const project: ProjectConfig = {
  name: "smoke-test",
  repo: "test/repo",
  path: "/tmp",
  defaultBranch: "main",
  sessionPrefix: "test",
  tracker: { plugin: "jira", projectKey: issueKey.split("-")[0] },
};

const tracker = create();

console.log("--- getIssue ---");
const issue = await tracker.getIssue(issueKey, project);
console.log(issue);

console.log("\n--- isCompleted ---");
const completed = await tracker.isCompleted(issueKey, project);
console.log("completed:", completed);

console.log("\n--- issueUrl ---");
console.log(tracker.issueUrl(issueKey, project));

console.log("\n--- issueLabel ---");
console.log(tracker.issueLabel?.(tracker.issueUrl(issueKey, project), project));

console.log("\n--- branchName ---");
console.log(tracker.branchName(issueKey, project));

console.log("\n--- generatePrompt ---");
const prompt = await tracker.generatePrompt(issueKey, project);
console.log(prompt);

console.log("\n--- listIssues (open) ---");
const issues = await tracker.listIssues!({}, project);
console.log(`Found ${issues.length} open issues:`);
for (const i of issues) {
  console.log(`  ${i.id}: ${i.title} [${i.state}]`);
}
