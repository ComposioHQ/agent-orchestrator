import assert from "node:assert/strict";
import test from "node:test";
import {
  extractConfiguredReposFromYaml,
  fetchIssues,
  mergeStringLists,
  parseStringArraySetting,
  getDashboardBaseUrl,
  constructDashboardUrl,
} from "./index.ts";

function makeIssue(number: number, title: string, repo: string) {
  return {
    number,
    title,
    labels: [],
    state: "open",
    assignees: [],
    createdAt: `2026-03-${String(number).padStart(2, "0")}T00:00:00Z`,
    url: `https://github.com/${repo}/issues/${number}`,
  };
}

test("extractConfiguredReposFromYaml reads every project repo", () => {
  const rawYaml = `
port: 3000
projects:
  app:
    repo: acme/app
    path: ~/code/app
  docs:
    repo: "acme/docs" # keep quoted repos working
    path: ~/code/docs
notifiers:
  openclaw:
    plugin: openclaw
`;

  assert.deepEqual(extractConfiguredReposFromYaml(rawYaml), ["acme/app", "acme/docs"]);
});

test("fetchIssues queries every configured repo when repo is omitted", () => {
  const ghCalls: string[] = [];
  const result = fetchIssues(
    { aoCwd: "/tmp/work" },
    {},
    {
      getConfiguredRepos: () => ["acme/app", "acme/docs"],
      runGh: (_config, args) => {
        const repoIndex = args.indexOf("-R");
        const repo = repoIndex >= 0 ? args[repoIndex + 1] : "default";
        ghCalls.push(repo);

        if (repo === "acme/app") {
          return { ok: true, output: JSON.stringify([makeIssue(1, "App bug", repo)]) };
        }
        if (repo === "acme/docs") {
          return { ok: true, output: JSON.stringify([makeIssue(2, "Docs bug", repo)]) };
        }

        return { ok: false, error: `unexpected repo: ${repo}` };
      },
    },
  );

  assert.deepEqual(ghCalls, ["acme/app", "acme/docs"]);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.scannedRepos, ["acme/app", "acme/docs"]);
  assert.equal(result.warnings.length, 0);
  assert.deepEqual(
    result.issues.map((issue) => issue.repository),
    ["acme/docs", "acme/app"],
  );
});

test("fetchIssues surfaces GitHub failures instead of reporting an empty board", () => {
  const result = fetchIssues(
    { aoCwd: "/tmp/work" },
    {},
    {
      getConfiguredRepos: () => ["acme/app"],
      runGh: () => ({ ok: false, error: "gh auth token missing" }),
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /gh auth token missing/);
});

test("fetchIssues keeps partial failures visible when at least one repo succeeds", () => {
  const result = fetchIssues(
    { aoCwd: "/tmp/work" },
    {},
    {
      getConfiguredRepos: () => ["acme/app", "acme/docs"],
      runGh: (_config, args) => {
        const repoIndex = args.indexOf("-R");
        const repo = repoIndex >= 0 ? args[repoIndex + 1] : "default";
        if (repo === "acme/app") {
          return { ok: true, output: JSON.stringify([makeIssue(3, "App bug", repo)]) };
        }
        return { ok: false, error: "gh not authenticated for docs repo" };
      },
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.issues.length, 1);
  assert.deepEqual(result.warnings, ["acme/docs: gh not authenticated for docs repo"]);
});

test("allowlist helpers preserve existing entries while adding AO requirements", () => {
  assert.deepEqual(mergeStringLists(["custom:tools", "group:plugins"], ["group:plugins"]), [
    "custom:tools",
    "group:plugins",
  ]);
  assert.deepEqual(parseStringArraySetting('["group:plugins","custom:tools"]'), [
    "group:plugins",
    "custom:tools",
  ]);
  assert.deepEqual(parseStringArraySetting("null"), []);
});

test("getDashboardBaseUrl extracts dashboardBaseUrl from config", () => {
  const mockConfigPath = "/tmp/test-ao-config.yaml";
  const originalResolveAoConfigPath = (global as any).__resolveAoConfigPath;
  const originalReadFileSync = (global as any).__readFileSync;

  (global as any).__resolveAoConfigPath = () => mockConfigPath;
  (global as any).__readFileSync = (path: string) => {
    if (path === mockConfigPath) {
      return "port: 3000\ndashboardBaseUrl: http://91.107.194.138:3000\n\nprojects:\n  test:\n    repo: test/repo";
    }
    throw new Error("Unexpected read");
  };

  try {
    const config = { aoCwd: "/tmp" };
    const result = getDashboardBaseUrl(config);
    assert.equal(result, "http://91.107.194.138:3000");
  } finally {
    (global as any).__resolveAoConfigPath = originalResolveAoConfigPath;
    (global as any).__readFileSync = originalReadFileSync;
  }
});

test("getDashboardBaseUrl returns null when not configured", () => {
  const mockConfigPath = "/tmp/test-ao-config.yaml";
  const originalResolveAoConfigPath = (global as any).__resolveAoConfigPath;
  const originalReadFileSync = (global as any).__readFileSync;

  (global as any).__resolveAoConfigPath = () => mockConfigPath;
  (global as any).__readFileSync = (path: string) => {
    if (path === mockConfigPath) {
      return "port: 3000\n\nprojects:\n  test:\n    repo: test/repo";
    }
    throw new Error("Unexpected read");
  };

  try {
    const config = { aoCwd: "/tmp" };
    const result = getDashboardBaseUrl(config);
    assert.equal(result, null);
  } finally {
    (global as any).__resolveAoConfigPath = originalResolveAoConfigPath;
    (global as any).__readFileSync = originalReadFileSync;
  }
});

test("getDashboardBaseUrl handles quoted URLs", () => {
  const mockConfigPath = "/tmp/test-ao-config.yaml";
  const originalResolveAoConfigPath = (global as any).__resolveAoConfigPath;
  const originalReadFileSync = (global as any).__readFileSync;

  (global as any).__resolveAoConfigPath = () => mockConfigPath;
  (global as any).__readFileSync = (path: string) => {
    if (path === mockConfigPath) {
      return 'dashboardBaseUrl: "http://example.com:3000"\n\nprojects:\n  test:\n    repo: test/repo';
    }
    throw new Error("Unexpected read");
  };

  try {
    const config = { aoCwd: "/tmp" };
    const result = getDashboardBaseUrl(config);
    assert.equal(result, "http://example.com:3000");
  } finally {
    (global as any).__resolveAoConfigPath = originalResolveAoConfigPath;
    (global as any).__readFileSync = originalReadFileSync;
  }
});

test("constructDashboardUrl builds correct session URL", () => {
  assert.equal(
    constructDashboardUrl("ao-123", "http://example.com:3000"),
    "http://example.com:3000/sessions/ao-123"
  );
  assert.equal(
    constructDashboardUrl("my-session", "https://dashboard.example.com"),
    "https://dashboard.example.com/sessions/my-session"
  );
  assert.equal(
    constructDashboardUrl("session-1", "http://example.com:3000/"),
    "http://example.com:3000/sessions/session-1"
  );
});
