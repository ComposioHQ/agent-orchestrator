/**
 * Orchestrator Prompt Generator — generates orchestrator prompt content.
 *
 * This is injected via `ao start` to provide orchestrator-specific context
 * when the orchestrator agent runs.
 */

import { PromptLoader } from "./prompts/loader.js";
import type { OrchestratorConfig, ProjectConfig } from "./types.js";

export interface OrchestratorPromptConfig {
  loader: PromptLoader;
  config: OrchestratorConfig;
  projectId: string;
  project: ProjectConfig;
}

/**
 * Generate orchestrator prompt content.
 * Provides orchestrator agent with context about available commands,
 * session management workflows, and project configuration.
 */
export function generateOrchestratorPrompt(opts: OrchestratorPromptConfig): string {
  const { loader, config, projectId, project } = opts;
  const reactionLines: string[] = [];

  if (project.reactions && Object.keys(project.reactions).length > 0) {
    for (const [event, reaction] of Object.entries(project.reactions)) {
      if (reaction.auto && reaction.action === "send-to-agent") {
        reactionLines.push(
          `- **${event}**: Auto-sends instruction to agent (retries: ${reaction.retries ?? "none"}, escalates after: ${reaction.escalateAfter ?? "never"})`,
        );
      } else if (reaction.auto && reaction.action === "notify") {
        reactionLines.push(
          `- **${event}**: Notifies human (priority: ${reaction.priority ?? "info"})`,
        );
      }
    }
  }

  const reactionsSection =
    reactionLines.length > 0
      ? `\n\n## Automated Reactions

The system automatically handles these events:

${reactionLines.join("\n")}`
      : "";

  const projectRulesSection = project.orchestratorRules
    ? `\n\n## Project-Specific Rules

${project.orchestratorRules}`
    : "";

  return loader.render("orchestrator", {
    config,
    projectId,
    project,
    reactionsSection,
    projectRulesSection,
  });
}
