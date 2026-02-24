import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { McpToolPlugin, HealthResult, ReactionType } from "./types.js";

export interface McpInjectionSession {
  worktreePath: string;
  metadata?: Record<string, unknown>;
}

export interface InjectionResult {
  mcpJsonPath: string;
  failedPlugins: Array<{ name: string; reason: string }>;
  blockedByHardware: boolean;
  hardwareReaction?: ReactionType;
}

/**
 * Run health checks, then write a scoped .mcp.json to the worktree.
 * If any plugin fails health check with onUnhealthy()='hardware-test-required',
 * returns blockedByHardware:true. Caller must not launch agent in that case.
 */
export async function injectMcpConfig(
  session: McpInjectionSession,
  plugins: McpToolPlugin[],
): Promise<InjectionResult> {
  if (plugins.length === 0) {
    return { mcpJsonPath: "", failedPlugins: [], blockedByHardware: false };
  }

  const failedPlugins: InjectionResult["failedPlugins"] = [];
  let blockedByHardware = false;
  let hardwareReaction: ReactionType | undefined;

  // Health checks in parallel
  const checks = plugins
    .filter((p) => typeof p.healthCheck === "function")
    .map(async (p) => ({ plugin: p, result: await p.healthCheck!() }));

  const settled = await Promise.allSettled(checks);

  for (const s of settled) {
    if (s.status === "rejected") continue;
    const { plugin, result } = s.value;
    if (!result.healthy) {
      const reaction = plugin.onUnhealthy?.();
      failedPlugins.push({
        name: plugin.name,
        reason: result.message ?? "unhealthy",
      });
      if (reaction === "hardware-test-required") {
        blockedByHardware = true;
        hardwareReaction = reaction;
      }
    }
  }

  if (blockedByHardware) {
    return { mcpJsonPath: "", failedPlugins, blockedByHardware, hardwareReaction };
  }

  // Only include healthy plugins in .mcp.json
  const failedNames = new Set(failedPlugins.map((f) => f.name));
  const healthy = plugins.filter((p) => !failedNames.has(p.name));

  const mcpJson = {
    mcpServers: Object.fromEntries(
      healthy.map((p) => [p.name, p.buildMcpJson()]),
    ),
  };

  const mcpJsonPath = path.join(session.worktreePath, ".mcp.json");
  await fs.writeFile(mcpJsonPath, JSON.stringify(mcpJson, null, 2), "utf-8");

  // Store for cleanup
  if (session.metadata) {
    session.metadata["mcpJsonPath"] = mcpJsonPath;
  }

  return { mcpJsonPath, failedPlugins, blockedByHardware: false };
}

/** Remove .mcp.json on session cleanup */
export async function cleanupMcpConfig(
  session: McpInjectionSession,
): Promise<void> {
  const p = session.metadata?.["mcpJsonPath"] as string | undefined;
  if (p) {
    await fs.rm(p, { force: true });
  }
}
