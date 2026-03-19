export type CallerType = "human" | "orchestrator" | "agent";

/**
 * Detect who is calling the CLI.
 * - If AO_CALLER_TYPE is set, trust it.
 * - Otherwise, if stdout is a TTY, it's a human.
 * - Non-TTY defaults to "agent".
 */
export function getCallerType(): CallerType {
  const env = process.env["AO_CALLER_TYPE"];
  if (env === "orchestrator" || env === "agent" || env === "human") {
    return env;
  }
  return process.stdout.isTTY ? "human" : "agent";
}

/**
 * Returns true if the caller is a human (interactive terminal).
 */
export function isHumanCaller(): boolean {
  return getCallerType() === "human";
}
