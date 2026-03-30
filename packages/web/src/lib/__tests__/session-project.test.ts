import { describe, it, expect } from "vitest";
import type { OrchestratorConfig } from "@composio/ao-core";
import { resolveProjectIdForSessionId } from "@/lib/session-project";

const config: OrchestratorConfig = {
  configPath: "/tmp/ao.yaml",
  port: 3000,
  readyThresholdMs: 300_000,
  defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
  projects: {
    "my-app": {
      name: "My App",
      repo: "acme/my-app",
      path: "/tmp/my-app",
      defaultBranch: "main",
      sessionPrefix: "my-app",
    },
    "docs": {
      name: "Docs",
      repo: "acme/docs",
      path: "/tmp/docs",
      defaultBranch: "main",
      sessionPrefix: "docs",
    },
  },
  notifiers: {},
  notificationRouting: { urgent: [], action: [], warning: [], info: [] },
  reactions: {},
};

describe("resolveProjectIdForSessionId", () => {
  it("matches exact session prefix", () => {
    expect(resolveProjectIdForSessionId(config, "my-app")).toBe("my-app");
  });

  it("matches session id starting with prefix and hyphen", () => {
    expect(resolveProjectIdForSessionId(config, "my-app-3")).toBe("my-app");
    expect(resolveProjectIdForSessionId(config, "docs-7")).toBe("docs");
  });

  it("returns undefined for unknown session ids", () => {
    expect(resolveProjectIdForSessionId(config, "unknown-session")).toBeUndefined();
  });

  it("does not match partial prefix without hyphen separator", () => {
    // "my-appX" should NOT match "my-app" prefix (no hyphen)
    expect(resolveProjectIdForSessionId(config, "my-appX")).toBeUndefined();
  });

  it("handles empty projects", () => {
    const emptyConfig = { ...config, projects: {} };
    expect(resolveProjectIdForSessionId(emptyConfig, "anything")).toBeUndefined();
  });
});
