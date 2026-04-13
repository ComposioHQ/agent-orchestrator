import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { generateOrchestratorPrompt } from "../orchestrator-prompt.js";
import { PromptLoader } from "../prompts/loader.js";
import type { OrchestratorConfig } from "../types.js";

const config: OrchestratorConfig = {
  configPath: "/tmp/agent-orchestrator.yaml",
  port: 3000,
  defaults: {
    runtime: "tmux",
    agent: "claude-code",
    workspace: "worktree",
    notifiers: ["desktop"],
  },
  projects: {
    "my-app": {
      name: "My App",
      repo: "org/my-app",
      path: "/tmp/my-app",
      defaultBranch: "main",
      sessionPrefix: "app",
    },
  },
  notifiers: {},
  notificationRouting: {
    urgent: ["desktop"],
    action: ["desktop"],
    warning: [],
    info: [],
  },
  reactions: {},
  readyThresholdMs: 300_000,
};

let tmpProjectDir: string;
let loader: PromptLoader;

beforeEach(() => {
  tmpProjectDir = join(tmpdir(), `ao-orchestrator-prompt-${randomUUID()}`);
  const promptsDir = join(tmpProjectDir, ".agent-orchestrator", "prompts");
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(
    join(promptsDir, "orchestrator.yaml"),
    `name: orchestrator
description: test orchestrator prompt
variables:
  - project.name
  - project.repo
  - config.port
  - reactionsSection
  - projectRulesSection
template: |-
  Orchestrating \${project.name} (\${project.repo}) on port \${config.port}\${reactionsSection}\${projectRulesSection}`,
  );
  loader = new PromptLoader({ projectDir: tmpProjectDir });
});

afterEach(() => {
  rmSync(tmpProjectDir, { recursive: true, force: true });
});

describe("generateOrchestratorPrompt", () => {
  it("requires read-only investigation from the orchestrator session", () => {
    const prompt = generateOrchestratorPrompt({
      loader,
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("Orchestrating My App (org/my-app) on port 3000");
  });

  it("renders preformatted reactions and rules sections through the loader", () => {
    const project = {
      ...config.projects["my-app"]!,
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent" as const,
          retries: 2,
          escalateAfter: "15m",
        },
      },
      orchestratorRules: "Never touch production data directly.",
    };

    const prompt = generateOrchestratorPrompt({
      loader,
      config,
      projectId: "my-app",
      project,
    });

    expect(prompt).toContain("## Automated Reactions");
    expect(prompt).toContain("ci-failed");
    expect(prompt).toContain("## Project-Specific Rules");
    expect(prompt).toContain("Never touch production data directly.");
  });

  it("omits optional sections cleanly when absent", () => {
    const prompt = generateOrchestratorPrompt({
      loader,
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).not.toContain("## Automated Reactions");
    expect(prompt).not.toContain("## Project-Specific Rules");
  });
});
