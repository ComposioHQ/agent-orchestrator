/**
 * Bootstrap — generates per-agent/phase bootstrap scripts and config injections.
 *
 * The phase engine writes bootstrap.sh per agent/phase, sourced before agent launch.
 * It also injects toolkit instructions into agent config files (.claude/CLAUDE.md, AGENTS.md).
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Phase } from "@composio/ao-core";

/** Options for generating a bootstrap script */
export interface BootstrapOptions {
  /** Agent name */
  agentName: string;
  /** Current phase */
  phase: Phase;
  /** Worktree path */
  worktreePath: string;
  /** .agents/ directory path */
  agentsDir: string;
  /** File scope for this agent */
  fileScope: string[];
  /** Shared files */
  sharedFiles: string[];
}

/** Generate the bootstrap.sh script for an agent/phase activation */
export function generateBootstrapScript(options: BootstrapOptions): string {
  const {
    agentName,
    phase,
    worktreePath,
    agentsDir,
    fileScope,
    sharedFiles,
  } = options;

  return [
    "#!/usr/bin/env bash",
    "# Auto-generated bootstrap for ao-teams agent activation",
    `# Agent: ${agentName}, Phase: ${phase}`,
    "",
    `export AO_AGENT_NAME="${agentName}"`,
    `export AO_PHASE="${phase}"`,
    `export AO_WORKTREE="${worktreePath}"`,
    `export AO_AGENTS_DIR="${agentsDir}"`,
    `export AO_FILE_SCOPE="${fileScope.join(",")}"`,
    `export AO_SHARED_FILES="${sharedFiles.join(",")}"`,
    `source "\${AO_AGENTS_DIR}/bin/ao-bus.sh"`,
    "",
  ].join("\n");
}

/** Write bootstrap.sh to the .agents/ directory */
export function writeBootstrapScript(options: BootstrapOptions): string {
  const script = generateBootstrapScript(options);
  const scriptPath = join(options.agentsDir, `bootstrap-${options.agentName}.sh`);
  writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

/**
 * Generate CLAUDE.md content for toolkit injection.
 * This is written to .claude/CLAUDE.md in the worktree so agents
 * discover the toolkit even without sourcing bootstrap.sh.
 */
export function generateToolkitClaudeMd(options: BootstrapOptions): string {
  const { agentName, phase, agentsDir, fileScope, sharedFiles } = options;
  const cliBin = `${agentsDir}/bin/ao-bus-cli`;

  return [
    "# ao-teams Agent Toolkit",
    "",
    "You are part of a coordinated team. Use these commands to communicate.",
    "",
    "## Quick Reference",
    "",
    "```bash",
    "# Status",
    `${cliBin} --agent ${agentName} --phase ${phase} status done`,
    `${cliBin} --agent ${agentName} --phase ${phase} status working --file <path>`,
    "",
    "# Messages",
    `${cliBin} --agent ${agentName} --phase ${phase} msg <to> "<content>"`,
    `${cliBin} --agent ${agentName} --phase ${phase} inbox`,
    "",
    "# Context",
    `${cliBin} --agent ${agentName} --phase ${phase} context`,
    `${cliBin} --agent ${agentName} --phase ${phase} context --files`,
    "",
    "# Learnings",
    `${cliBin} --agent ${agentName} --phase ${phase} learn <convention|pitfall|decision> "<desc>"`,
    "```",
    "",
    `## Your Role: ${agentName}`,
    `## Current Phase: ${phase}`,
    `## Assigned Files: ${fileScope.join(", ") || "(none)"}`,
    `## Shared Files (read-only in implement): ${sharedFiles.join(", ") || "(none)"}`,
    "",
    "**IMPORTANT:** Always run `ao-status done` when your phase work is complete.",
    "",
  ].join("\n");
}

/**
 * Inject toolkit CLAUDE.md into the worktree's .claude/ directory.
 * Appends to existing CLAUDE.md if present.
 */
export function injectToolkitConfig(
  worktreePath: string,
  options: BootstrapOptions,
): void {
  const claudeDir = join(worktreePath, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const claudeMdPath = join(claudeDir, "CLAUDE.md");
  const toolkitContent = generateToolkitClaudeMd(options);

  let existing = "";
  if (existsSync(claudeMdPath)) {
    existing = readFileSync(claudeMdPath, "utf-8");
    // Don't inject if already present
    if (existing.includes("ao-teams Agent Toolkit")) return;
    existing += "\n\n";
  }

  writeFileSync(claudeMdPath, existing + toolkitContent, "utf-8");
}
