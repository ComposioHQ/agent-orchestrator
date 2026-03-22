/**
 * Agent runtime detection — discovers available agent runtimes via plugin detect() methods.
 *
 * No hardcoded binary paths — relies entirely on each plugin's detect() export.
 */

import type { PluginModule } from "@composio/ao-core";
import { isHumanCaller } from "./caller-context.js";

export interface DetectedAgent {
  name: string;
  displayName: string;
}

/** Known agent plugins — package name mapping. */
const AGENT_PLUGINS: Array<{ name: string; pkg: string }> = [
  { name: "claude-code", pkg: "@composio/ao-plugin-agent-claude-code" },
  { name: "aider", pkg: "@composio/ao-plugin-agent-aider" },
  { name: "codex", pkg: "@composio/ao-plugin-agent-codex" },
  { name: "acpx", pkg: "@composio/ao-plugin-agent-acpx" },
  { name: "opencode", pkg: "@composio/ao-plugin-agent-opencode" },
];

/**
 * Discover which agent runtimes are available on this system.
 * Imports each agent plugin and calls its detect() method.
 */
export async function detectAvailableAgents(): Promise<DetectedAgent[]> {
  const available: DetectedAgent[] = [];

  for (const { name, pkg } of AGENT_PLUGINS) {
    try {
      const raw = await import(pkg);
      // Handle both named export and default export shapes
      const mod = (raw.detect ? raw : raw.default) as PluginModule;
      if (typeof mod?.detect === "function" && mod.detect()) {
        available.push({
          name,
          displayName: mod.manifest?.displayName ?? name,
        });
      }
    } catch {
      // Plugin not installed or import failed — skip
    }
  }

  return available;
}

/**
 * Select the agent runtime to use for config generation.
 *
 * - No agents detected → default to "claude-code"
 * - One agent available → auto-select it
 * - Multiple agents available + human caller → prompt to pick
 * - Multiple agents available + non-human → pick first (claude-code if available)
 */
export async function detectAgentRuntime(): Promise<string> {
  const available = await detectAvailableAgents();

  if (available.length === 0) {
    return "claude-code";
  }

  if (available.length === 1) {
    return available[0].name;
  }

  // Multiple agents available
  if (!isHumanCaller()) {
    // Non-interactive: prefer claude-code if available, else first
    return available.find((a) => a.name === "claude-code")?.name ?? available[0].name;
  }

  // Interactive: prompt human to pick using node:readline (no external deps)
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("\n  Multiple agent runtimes detected:\n");
    available.forEach((a, i) => {
      console.log(`  ${i + 1}. ${a.displayName} (${a.name})`);
    });
    console.log();

    const answer = await rl.question(`  Choose default agent [1-${available.length}]: `);

    const idx = parseInt(answer.trim(), 10) - 1;
    if (idx >= 0 && idx < available.length) {
      return available[idx].name;
    }

    // Invalid input — default to first
    return available[0].name;
  } finally {
    rl.close();
  }
}
