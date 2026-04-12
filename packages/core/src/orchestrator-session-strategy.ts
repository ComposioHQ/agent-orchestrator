import type { ProjectConfig } from "./types.js";

export type NormalizedOrchestratorSessionStrategy = "reuse" | "delete" | "ignore" | "new";

/**
 * Normalize orchestrator session strategy to canonical values.
 *
 * Legacy aliases (kill-previous, delete-new, ignore-new) are normalized at the
 * Zod schema level during config parsing. This function handles the remaining
 * default assignment for callers that may receive undefined.
 */
export function normalizeOrchestratorSessionStrategy(
  strategy: ProjectConfig["orchestratorSessionStrategy"] | undefined,
): NormalizedOrchestratorSessionStrategy {
  // Legacy aliases are already normalized by the Zod transform in config.ts,
  // but handle them here too for callers that bypass config parsing.
  if (strategy === "kill-previous" as string || strategy === "delete-new" as string) return "delete";
  if (strategy === "ignore-new" as string) return "ignore";
  return strategy ?? "reuse";
}
