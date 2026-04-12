/**
 * Prompt Builder — composes layered prompts for agent sessions.
 *
 * Three layers:
 *   1. BASE_AGENT_PROMPT — constant instructions about session lifecycle, git workflow, PR handling
 *   2. Config-derived context — project name, repo, default branch, tracker info, reaction rules
 *   3. User rules — inline agentRules and/or agentRulesFile content
 *
 * buildPrompt() always returns the AO base guidance and project context so
 * bare launches still know about AO-specific commands such as PR claiming.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PromptLoader } from "./prompts/loader.js";
import type { ProjectConfig } from "./types.js";

// =============================================================================
// TYPES
// =============================================================================

export interface PromptBuildConfig {
  /** Loader for YAML-backed prompt templates */
  loader: PromptLoader;
  /** The project config from the orchestrator config */
  project: ProjectConfig;

  /** The project ID (key in the projects map) */
  projectId: string;

  /** Issue identifier (e.g. "INT-1343", "#42") — triggers Layer 1+2 */
  issueId?: string;

  /** Pre-fetched issue context from tracker.generatePrompt() */
  issueContext?: string;

  /** Explicit user prompt (appended last) */
  userPrompt?: string;
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
 * issue context, user rules, and explicit instructions when available.
 */
export function buildPrompt(config: PromptBuildConfig): string {
  const userRules = readUserRules(config.project);
  const sections: string[] = [];

  // Layer 1: Base prompt is always included for every managed session.
  sections.push(config.loader.render("base-agent", {}));

  // Layer 2: Config-derived context
  sections.push(buildConfigLayer(config));

  // Layer 3: User rules
  if (userRules) {
    sections.push(`## Project Rules\n${userRules}`);
  }

  // Explicit user prompt (appended last, highest priority)
  if (config.userPrompt) {
    sections.push(`## Additional Instructions\n${config.userPrompt}`);
  }

  return sections.join("\n\n");
}

// =============================================================================
// ADVERSARIAL PHASE PROMPTS
// =============================================================================

/** Discriminated phase for adversarial prompt generation. */
export type AdversarialPhase =
  | "planning"
  | "plan_review"
  | "working"
  | "working_after_code_review"
  | "code_review";

export interface AdversarialPhaseContext {
  phase: AdversarialPhase;
  round: number;
  maxRounds: number;
}

const ADVERSARIAL_DIR = ".ao/adversarial";

/**
 * Build a phase-specific prompt fragment for adversarial validation.
 * This is appended on top of the existing 3-layer prompt.
 */
export function buildPhasePrompt(ctx: AdversarialPhaseContext): string {
  const { phase, round } = ctx;

  switch (phase) {
    case "planning": {
      const lines = [
        "## Adversarial Validation — Planning Phase",
        "",
        `You are in planning round ${round + 1}/${ctx.maxRounds}.`,
        "",
      ];
      if (round === 0) {
        lines.push(
          "Draft a detailed implementation plan for the task assigned to you.",
          `Write it to \`${ADVERSARIAL_DIR}/plan.md\`.`,
          "The plan should cover: approach, files to modify, edge cases, test strategy.",
          "Do not write any code yet — only the plan.",
          `Update \`${ADVERSARIAL_DIR}/progress.md\` with what you accomplished this phase.`,
          "Exit when the plan is complete.",
        );
      } else {
        lines.push(
          `A critique of your previous plan has been written to \`${ADVERSARIAL_DIR}/plan.critique.md\`.`,
          "Read it carefully and produce a revised plan that addresses the feedback.",
          `Write the revised plan to \`${ADVERSARIAL_DIR}/plan.md\` (overwrite the previous version).`,
          "Do not write any code yet — only the revised plan.",
          `Update \`${ADVERSARIAL_DIR}/progress.md\` with what you changed and why.`,
          "Exit when the revised plan is complete.",
        );
      }
      return lines.join("\n");
    }

    case "plan_review": {
      return [
        "## Adversarial Validation — Plan Review",
        "",
        "You are an adversarial reviewer. Your job is to find problems before code is written.",
        "",
        "**Startup: orient yourself before reviewing.**",
        "1. Run `git log --oneline -20` to understand recent history.",
        `2. Read \`${ADVERSARIAL_DIR}/plan.md\` thoroughly.`,
        "3. If an issue description exists, read it for requirements context.",
        "",
        "**Then write your critique:**",
        `Write a structured critique to \`${ADVERSARIAL_DIR}/plan.critique.md\` covering:`,
        "- Missing requirements or acceptance criteria",
        "- Risky assumptions",
        "- Simpler alternatives the author may have overlooked",
        "- Test gaps",
        "- Potential integration issues",
        "",
        "Be concrete and actionable — cite specific sections of the plan.",
        `Do not modify \`${ADVERSARIAL_DIR}/plan.md\` or any source files.`,
        `Update \`${ADVERSARIAL_DIR}/progress.md\` with a one-line summary of your review.`,
        "Exit when your critique is complete.",
      ].join("\n");
    }

    case "working": {
      return [
        "## Adversarial Validation — Implementation Phase",
        "",
        `Follow the plan in \`${ADVERSARIAL_DIR}/plan.md\`.`,
        "",
        "**Before writing code, run the existing test suite** to establish a baseline.",
        "Note any pre-existing failures so you don't waste time on them.",
        "",
        "Implement the plan incrementally — commit after each logical unit of work.",
        `Update \`${ADVERSARIAL_DIR}/progress.md\` as you complete each section.`,
        "When implementation is complete, open a PR (or let the orchestrator detect your commits).",
      ].join("\n");
    }

    case "working_after_code_review": {
      return [
        "## Adversarial Validation — Post-Review Refinement",
        "",
        `A code review has been written to \`${ADVERSARIAL_DIR}/code.critique.md\`.`,
        "Read it carefully and apply the fixes.",
        "",
        "**Before making changes, run the existing test suite** to confirm current state.",
        "",
        "Address each item in the critique. Skip items you disagree with, but document why",
        `in \`${ADVERSARIAL_DIR}/progress.md\`.`,
        "Commit after each fix.",
      ].join("\n");
    }

    case "code_review": {
      return [
        "## Adversarial Validation — Code Review",
        "",
        "You are an adversarial code reviewer. Find bugs before they ship.",
        "",
        "**Startup: orient yourself before reviewing.**",
        "1. Run `git log --oneline -20` to understand what was done.",
        "2. Run `git diff main...HEAD` to see all changes.",
        `3. Read \`${ADVERSARIAL_DIR}/plan.md\` for intended design.`,
        `4. Read \`${ADVERSARIAL_DIR}/progress.md\` for implementation notes.`,
        "",
        "**Then write your critique:**",
        `Write to \`${ADVERSARIAL_DIR}/code.critique.md\` covering:`,
        "- Bugs and logic errors",
        "- Security issues (injection, XSS, auth bypass)",
        "- Test coverage gaps",
        `- Deviations from \`${ADVERSARIAL_DIR}/plan.md\``,
        "- Performance concerns",
        "",
        "Be concrete — cite file paths and line numbers.",
        "Do not modify any source files.",
        `Update \`${ADVERSARIAL_DIR}/progress.md\` with a one-line summary of your review.`,
        "Exit when your review is complete.",
      ].join("\n");
    }
  }
}
