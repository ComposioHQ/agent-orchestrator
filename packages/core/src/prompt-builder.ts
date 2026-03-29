/**
 * Prompt Builder — composes layered prompts for agent sessions.
 *
 * Layers (in order):
 *   1. BASE_AGENT_PROMPT — session lifecycle, planning workflow, feature plans, git, PRs
 *   2. Session focus — optional explicit userPrompt from spawn config
 *   3. Config-derived context — project name, repo, default branch, tracker, reactions, task/issue
 *   4. User rules — inline agentRules and/or agentRulesFile content
 *   5. Decomposition context — lineage and siblings when present
 *
 * buildPrompt() always returns the AO base guidance and project context so
 * bare launches still know about AO-specific commands such as PR claiming.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectConfig } from "./types.js";

// =============================================================================
// LAYER 1: BASE AGENT PROMPT
// =============================================================================

export const BASE_AGENT_PROMPT = `You are an AI coding agent managed by the Agent Orchestrator (ao).

## Session Lifecycle
- You are running inside a managed session. Focus on the assigned task.
- **Your default mode is PLANNING, not coding.** Analyze the problem, research the codebase, and produce a written plan before making any code changes.
- Only implement code when the user explicitly requests it (e.g., "implement this", "start coding", "execute the plan").
- **If no task or issue is specified**, wait for instructions. Do not proactively research the codebase or generate plans — this avoids unnecessary context bloat.
- If you're told to take over or continue work on an existing PR, run \`ao session claim-pr <pr-number-or-url>\` from inside this session before making changes.
- If CI fails, the orchestrator will send you the failures — fix them and push again.
- If reviewers request changes, the orchestrator will forward their comments — address each one, push fixes, and reply to the comments.

## Planning workflow
Your primary deliverable is a **feature plan** — a Markdown document that captures:
- **Problem summary** — What issue or feature is being addressed?
- **Research findings** — Relevant code paths, dependencies, existing patterns discovered.
- **Proposed approach** — How you intend to solve it, with rationale.
- **Files to modify** — List of files you expect to touch.
- **Risks and open questions** — Unknowns, edge cases, areas needing human input.
- **Validation strategy** — How the change will be tested.
- **Implementation checklist** — A detailed, phased checklist with checkboxes for step-by-step execution.

Store plans under \`.feature-plans/\` at the project root (create it if missing):
- \`.feature-plans/pending/\` — planned work not started yet
- \`.feature-plans/wip/\` — actively in progress (move your plan here when working)
- \`.feature-plans/done/\` — completed or superseded plans (keep for history)

If \`.feature-plans/_plan_sample_format.md\` exists, use it as the reference format for your plan.

**Do not start implementation until the user approves or explicitly asks you to proceed.**

## Git Workflow
- Create your feature branch from the **Default branch** listed under **Project Context** below (e.g. \`main\` or \`gb-personal\` — never commit directly to that branch). If you are unsure, read it from Project Context; do not assume \`main\`.
- Open the pull request **against that same Default branch** (PR base = the branch you forked from). For personal integration lines such as \`gb-personal\`, both your branch point and PR target are that branch.
- If your local branch was mistakenly created from the wrong base (e.g. \`main\` instead of the configured default), **rebase onto the correct Default branch** before pushing or opening the PR.
- Use conventional commit messages (feat:, fix:, chore:, etc.).
- Push your branch and create a PR only after implementation is complete and tested.
- Keep PRs focused — one issue per PR.

## PR Best Practices
- Write a clear PR title and description explaining what changed and why.
- Link the issue in the PR description so it auto-closes when merged.
- If the repo has CI checks, make sure they pass before requesting review.
- Respond to every review comment, even if just to acknowledge it.`;

// =============================================================================
// TYPES
// =============================================================================

export interface PromptBuildConfig {
  /** The project config from the orchestrator config */
  project: ProjectConfig;

  /** The project ID (key in the projects map) */
  projectId: string;

  /** Issue identifier (e.g. "INT-1343", "#42") — triggers Layer 1+2 */
  issueId?: string;

  /** Pre-fetched issue context from tracker.generatePrompt() */
  issueContext?: string;

  /** Session-specific instructions (rendered early as ## Session Focus) */
  userPrompt?: string;

  /** Decomposition context — ancestor task chain (from decomposer) */
  lineage?: string[];

  /** Decomposition context — sibling task descriptions (from decomposer) */
  siblings?: string[];
}

// =============================================================================
// LAYER 2: CONFIG-DERIVED CONTEXT
// =============================================================================

function buildConfigLayer(config: PromptBuildConfig): string {
  const { project, projectId, issueId, issueContext } = config;
  const lines: string[] = [];

  lines.push("## Project Context");
  lines.push(`- Project: ${project.name ?? projectId}`);
  lines.push(`- Repository: ${project.repo}`);
  lines.push(`- Default branch: ${project.defaultBranch}`);
  lines.push(
    `- Branch feature work from this default branch and open PRs with **base** = this same branch (integration / merge target).`,
  );

  if (project.tracker) {
    lines.push(`- Tracker: ${project.tracker.plugin}`);
  }

  if (issueId) {
    lines.push(`\n## Task`);
    lines.push(`Work on issue: ${issueId}`);
    lines.push(
      `Create a branch named so that it auto-links to the issue tracker (e.g. feat/${issueId}).`,
    );
  }

  if (issueContext) {
    lines.push(`\n## Issue Details`);
    lines.push(issueContext);
  }

  // Include reaction rules so the agent knows what to expect
  if (project.reactions) {
    const reactionHints: string[] = [];
    for (const [event, reaction] of Object.entries(project.reactions)) {
      if (reaction.auto && reaction.action === "send-to-agent") {
        reactionHints.push(`- ${event}: auto-handled (you'll receive instructions)`);
      }
    }
    if (reactionHints.length > 0) {
      lines.push(`\n## Automated Reactions`);
      lines.push("The orchestrator will automatically handle these events:");
      lines.push(...reactionHints);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// LAYER 3: USER RULES
// =============================================================================

function readUserRules(project: ProjectConfig): string | null {
  const parts: string[] = [];

  if (project.agentRules) {
    parts.push(project.agentRules);
  }

  if (project.agentRulesFile) {
    const filePath = resolve(project.path, project.agentRulesFile);
    try {
      const content = readFileSync(filePath, "utf-8").trim();
      if (content) {
        parts.push(content);
      }
    } catch {
      // File not found or unreadable — skip silently (don't crash the spawn)
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Compose a layered prompt for an agent session.
 *
 * Always returns the AO base guidance plus project context, then layers on
 * session focus, issue context, user rules, and decomposition when available.
 */
export function buildPrompt(config: PromptBuildConfig): string {
  const userRules = readUserRules(config.project);
  const sections: string[] = [];

  // Layer 1: Base prompt is always included for every managed session.
  sections.push(BASE_AGENT_PROMPT);

  // Layer 2: Session focus — early so the agent sees spawn-time instructions immediately
  if (config.userPrompt) {
    sections.push(`## Session Focus\n${config.userPrompt}`);
  }

  // Layer 3: Config-derived context
  sections.push(buildConfigLayer(config));

  // Layer 4: User rules
  if (userRules) {
    sections.push(`## Project Rules\n${userRules}`);
  }

  // Layer 5: Decomposition context (lineage + siblings)
  if (config.lineage && config.lineage.length > 0) {
    const hierarchy = config.lineage.map((desc, i) => `${"  ".repeat(i)}${i}. ${desc}`);
    // Add current task marker using issueId or last lineage entry
    const currentLabel = config.issueId ?? "this task";
    hierarchy.push(`${"  ".repeat(config.lineage.length)}${config.lineage.length}. ${currentLabel}  <-- (this task)`);

    sections.push(
      `## Task Hierarchy\nThis task is part of a larger decomposed plan. Your place in the hierarchy:\n\n\`\`\`\n${hierarchy.join("\n")}\n\`\`\`\n\nStay focused on YOUR specific task. Do not implement functionality that belongs to other tasks in the hierarchy.`,
    );
  }

  if (config.siblings && config.siblings.length > 0) {
    const siblingLines = config.siblings.map((s) => `  - ${s}`);
    sections.push(
      `## Parallel Work\nSibling tasks being worked on in parallel:\n${siblingLines.join("\n")}\n\nDo not duplicate work that sibling tasks handle. If you need interfaces/types from siblings, define reasonable stubs.`,
    );
  }

  return sections.join("\n\n");
}
