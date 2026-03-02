import { describe, it, expect } from "vitest";
import type { AgentLaunchConfig } from "@composio/ao-core";
import { manifest, create } from "./index.js";

function makeLaunchConfig(overrides: Partial<AgentLaunchConfig> = {}): AgentLaunchConfig {
  return {
    sessionId: "sess-1",
    projectConfig: {
      name: "my-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "my",
    },
    ...overrides,
  };
}

describe("agent-goose", () => {
  it("has correct manifest", () => {
    expect(manifest.name).toBe("goose");
    expect(manifest.slot).toBe("agent");
  });

  it("builds launch command", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand(makeLaunchConfig({
      prompt: "Implement feature",
      permissions: "skip",
      model: "x-model",
    }));
    expect(cmd).toContain("run -t 'Implement feature'");
    expect(cmd).toContain("--model 'x-model'");
  });

  it("stays non-interactive when prompt is missing", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand(makeLaunchConfig({}));
    expect(cmd).toContain("run -t");
  });
});
