/**
 * Agent runtime selection and install prompts.
 *
 * Two flows:
 *   - promptAgentSelection: user overrides orchestrator/worker agents at startup
 *   - promptInstallAgentRuntime: offered when no agent runtime is detected
 */

import chalk from "chalk";
import { detectAvailableAgents, type DetectedAgent } from "./detect-agent.js";
import { promptSelect } from "./prompts.js";
import { canPromptForInstall, runInteractiveCommand } from "./installer.js";

interface AgentInstallOption {
  id: string;
  label: string;
  cmd: string;
  args: string[];
}

const AGENT_INSTALL_OPTIONS: AgentInstallOption[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    cmd: "npm",
    args: ["install", "-g", "@anthropic-ai/claude-code"],
  },
  {
    id: "codex",
    label: "OpenAI Codex",
    cmd: "npm",
    args: ["install", "-g", "@openai/codex"],
  },
  {
    id: "aider",
    label: "Aider",
    cmd: "pipx",
    args: ["install", "aider-chat"],
  },
  {
    id: "opencode",
    label: "OpenCode",
    cmd: "npm",
    args: ["install", "-g", "opencode-ai"],
  },
];

/**
 * Prompt the user to optionally switch orchestrator/worker agents at startup.
 * Shows only agents detected on the current system (reuses detectAvailableAgents).
 * Returns the chosen agents.
 */
export async function promptAgentSelection(): Promise<{
  orchestratorAgent: string;
  workerAgent: string;
} | null> {
  if (canPromptForInstall()) {
    const available = await detectAvailableAgents();
    if (available.length === 0) {
      console.log(chalk.yellow("No agent runtimes detected — using existing config."));
      return null;
    }

    const agentOptions = available.map((a) => ({ value: a.name, label: a.displayName }));

    const orchestratorAgent = await promptSelect("Orchestrator agent:", agentOptions);
    const workerAgent = await promptSelect("Worker agent:", agentOptions);

    return { orchestratorAgent, workerAgent };
  } else {
    return null;
  }
}

export async function promptInstallAgentRuntime(
  available: DetectedAgent[],
): Promise<DetectedAgent[]> {
  if (available.length > 0 || !canPromptForInstall()) return available;

  console.log(chalk.yellow("⚠ No supported agent runtime detected."));
  console.log(chalk.dim("  You can install one now (recommended) or continue and install later.\n"));
  const choice = await promptSelect(
    "Choose runtime to install:",
    [
      ...AGENT_INSTALL_OPTIONS.map((option) => ({
        value: option.id,
        label: option.label,
        hint: [option.cmd, ...option.args].join(" "),
      })),
      { value: "skip", label: "Skip for now" },
    ],
  );
  if (choice === "skip") {
    return available;
  }

  const selected = AGENT_INSTALL_OPTIONS.find((option) => option.id === choice);
  if (!selected) {
    return available;
  }

  console.log(chalk.dim(`  Installing ${selected.label}...`));
  try {
    await runInteractiveCommand(selected.cmd, selected.args);
    const refreshed = await detectAvailableAgents();
    if (refreshed.length > 0) {
      console.log(chalk.green(`  ✓ ${selected.label} installed successfully`));
    }
    return refreshed;
  } catch {
    console.log(chalk.yellow(`  ⚠ Could not install ${selected.label} automatically.`));
    return available;
  }
}
