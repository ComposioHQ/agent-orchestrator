import { describe, it, expect } from "vitest";
import {
  escapeRegex,
  matchesPrefix,
  findProjectForSession,
  isOrchestratorSessionName,
} from "../../src/lib/session-utils.js";
import type { OrchestratorConfig } from "@composio/ao-core";

describe("escapeRegex", () => {
  it("escapes dots, asterisks, plus, question marks", () => {
    expect(escapeRegex("a.b*c+d?e")).toBe("a\\.b\\*c\\+d\\?e");
  });

  it("escapes brackets and parens", () => {
    expect(escapeRegex("a[b](c){d}")).toBe("a\\[b\\]\\(c\\)\\{d\\}");
  });

  it("returns plain strings unchanged", () => {
    expect(escapeRegex("hello-world")).toBe("hello-world");
  });

  it("handles empty string", () => {
    expect(escapeRegex("")).toBe("");
  });

  it("escapes pipe and caret and dollar", () => {
    expect(escapeRegex("a|b^c$d")).toBe("a\\|b\\^c\\$d");
  });
});

describe("matchesPrefix", () => {
  it("matches prefix-1", () => {
    expect(matchesPrefix("app-1", "app")).toBe(true);
  });

  it("matches prefix-42", () => {
    expect(matchesPrefix("app-42", "app")).toBe(true);
  });

  it("rejects prefix- without number", () => {
    expect(matchesPrefix("app-", "app")).toBe(false);
  });

  it("rejects prefix-abc (non-numeric suffix)", () => {
    expect(matchesPrefix("app-abc", "app")).toBe(false);
  });

  it("rejects prefix-1-extra (trailing content)", () => {
    expect(matchesPrefix("app-1-extra", "app")).toBe(false);
  });

  it("rejects different prefix", () => {
    expect(matchesPrefix("other-1", "app")).toBe(false);
  });

  it("handles prefix containing regex special chars", () => {
    expect(matchesPrefix("my.app-5", "my.app")).toBe(true);
    expect(matchesPrefix("myXapp-5", "my.app")).toBe(false);
  });
});

describe("findProjectForSession", () => {
  const makeConfig = (projects: Record<string, { sessionPrefix?: string }>): OrchestratorConfig =>
    ({
      dataDir: "/tmp",
      worktreeDir: "/tmp/wt",
      port: 3000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: Object.fromEntries(
        Object.entries(projects).map(([id, p]) => [
          id,
          { name: id, repo: "", path: "", defaultBranch: "main", ...p },
        ]),
      ),
      notifiers: {},
      notificationRouting: {},
      reactions: {},
    }) as OrchestratorConfig;

  it("returns project ID when session matches prefix", () => {
    const config = makeConfig({ "my-app": { sessionPrefix: "app" } });
    expect(findProjectForSession(config, "app-1")).toBe("my-app");
  });

  it("returns null when no project matches", () => {
    const config = makeConfig({ "my-app": { sessionPrefix: "app" } });
    expect(findProjectForSession(config, "other-1")).toBeNull();
  });

  it("uses sessionPrefix over project ID when defined", () => {
    const config = makeConfig({ "my-app": { sessionPrefix: "custom" } });
    expect(findProjectForSession(config, "custom-1")).toBe("my-app");
    expect(findProjectForSession(config, "my-app-1")).toBeNull();
  });

  it("falls back to project ID when no sessionPrefix", () => {
    const config = makeConfig({ backend: {} });
    expect(findProjectForSession(config, "backend-1")).toBe("backend");
  });

  it("returns first match when multiple projects exist", () => {
    const config = makeConfig({
      alpha: { sessionPrefix: "a" },
      beta: { sessionPrefix: "b" },
    });
    expect(findProjectForSession(config, "a-1")).toBe("alpha");
    expect(findProjectForSession(config, "b-2")).toBe("beta");
  });
});

describe("isOrchestratorSessionName", () => {
  const makeConfig = (projects: Record<string, { sessionPrefix?: string }>): OrchestratorConfig =>
    ({
      dataDir: "/tmp",
      worktreeDir: "/tmp/wt",
      port: 3000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: Object.fromEntries(
        Object.entries(projects).map(([id, p]) => [
          id,
          { name: id, repo: "", path: "", defaultBranch: "main", ...p },
        ]),
      ),
      notifiers: {},
      notificationRouting: {},
      reactions: {},
    }) as OrchestratorConfig;

  it("matches the canonical orchestrator ID for a known project", () => {
    const config = makeConfig({ "my-app": { sessionPrefix: "app" } });
    expect(isOrchestratorSessionName(config, "app-orchestrator", "my-app")).toBe(true);
  });

  it("matches orchestrator IDs across configured projects without an explicit project", () => {
    const config = makeConfig({ "my-app": { sessionPrefix: "app" } });
    expect(isOrchestratorSessionName(config, "app-orchestrator")).toBe(true);
  });

  it("falls back to suffix detection for legacy orchestrator names", () => {
    const config = makeConfig({ "my-app": { sessionPrefix: "app" } });
    expect(isOrchestratorSessionName(config, "legacy-orchestrator")).toBe(true);
  });

  it("does not classify worker session IDs as orchestrators", () => {
    const config = makeConfig({ "my-app": { sessionPrefix: "app" } });
    expect(isOrchestratorSessionName(config, "app-12", "my-app")).toBe(false);
  });
});
