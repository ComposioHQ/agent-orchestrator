import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getWorkspaceAgentsMdPath,
  writeWorkspaceOpenCodeAgentsMd,
} from "../opencode-agents-md.js";

describe("opencode-agents-md", () => {
  const root = mkdtempSync(join(tmpdir(), "ao-opencode-agents-md-"));

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
  });

  it("writes AGENTS.md with only the orchestrator prompt block", () => {
    const workspacePath = join(root, "workspace");
    const promptFile = join(root, "prompt.md");
    writeFileSync(promptFile, "Use worker sessions only.\n", "utf-8");

    const agentsMdPath = writeWorkspaceOpenCodeAgentsMd(
      workspacePath,
      promptFile,
      "orchestrator",
    );

    expect(agentsMdPath).toBe(getWorkspaceAgentsMdPath(workspacePath));
    expect(readFileSync(agentsMdPath, "utf-8")).toBe(
      "<!-- AO_SYSTEM_PROMPT_START -->\n## Agent Orchestrator\n\nUse worker sessions only.\n<!-- AO_SYSTEM_PROMPT_END -->\n",
    );
  });

  it("preserves existing AGENTS.md content and appends the orchestrator block", () => {
    const workspacePath = join(root, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(
      join(workspacePath, "AGENTS.md"),
      "# Existing\n\nDo keep this.\n",
      "utf-8",
    );
    const promptFile = join(root, "prompt.md");
    writeFileSync(promptFile, "Merged orchestrator instructions.\n", "utf-8");

    writeWorkspaceOpenCodeAgentsMd(workspacePath, promptFile, "orchestrator");

    expect(readFileSync(join(workspacePath, "AGENTS.md"), "utf-8")).toBe(
      "# Existing\n\nDo keep this.\n\n<!-- AO_SYSTEM_PROMPT_START -->\n## Agent Orchestrator\n\nMerged orchestrator instructions.\n<!-- AO_SYSTEM_PROMPT_END -->\n",
    );
  });

  it("replaces only the existing AO block when rewriting", () => {
    const workspacePath = join(root, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(
      join(workspacePath, "AGENTS.md"),
      "# Existing\n\nBefore.\n\n<!-- AO_SYSTEM_PROMPT_START -->\n## Agent Orchestrator\n\nOld prompt.\n<!-- AO_SYSTEM_PROMPT_END -->\n\nAfter.\n",
      "utf-8",
    );
    const promptFile = join(root, "prompt.md");
    writeFileSync(promptFile, "New prompt.\n", "utf-8");

    writeWorkspaceOpenCodeAgentsMd(workspacePath, promptFile, "orchestrator");

    expect(readFileSync(join(workspacePath, "AGENTS.md"), "utf-8")).toBe(
      "# Existing\n\nBefore.\n\nAfter.\n\n<!-- AO_SYSTEM_PROMPT_START -->\n## Agent Orchestrator\n\nNew prompt.\n<!-- AO_SYSTEM_PROMPT_END -->\n",
    );
  });

  it("writes a worker-specific heading when requested", () => {
    const workspacePath = join(root, "workspace");
    const promptFile = join(root, "prompt.md");
    writeFileSync(promptFile, "Handle issue INT-100.\n", "utf-8");

    writeWorkspaceOpenCodeAgentsMd(workspacePath, promptFile, "worker");

    expect(readFileSync(join(workspacePath, "AGENTS.md"), "utf-8")).toBe(
      "<!-- AO_SYSTEM_PROMPT_START -->\n## Agent Worker\n\nHandle issue INT-100.\n<!-- AO_SYSTEM_PROMPT_END -->\n",
    );
  });
});
