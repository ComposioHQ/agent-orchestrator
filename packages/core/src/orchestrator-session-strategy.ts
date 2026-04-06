export type NormalizedOrchestratorSessionStrategy = "reuse" | "delete" | "ignore" | "new";

/**
 * Normalize an orchestrator session strategy value to its canonical form.
 *
 * Accepts both current values ("reuse", "delete", "ignore", "new") and legacy
 * aliases ("kill-previous", "delete-new", "ignore-new") so that runtime code
 * paths that bypass Zod parsing (e.g. CLI flags, migration helpers) still
 * produce the correct canonical value.
 */
export function normalizeOrchestratorSessionStrategy(
  strategy: string | undefined,
): NormalizedOrchestratorSessionStrategy {
  if (strategy === "kill-previous" || strategy === "delete-new") return "delete";
  if (strategy === "ignore-new") return "ignore";
  if (strategy === "reuse" || strategy === "delete" || strategy === "ignore" || strategy === "new") {
    return strategy;
  }
  return "reuse";
}
