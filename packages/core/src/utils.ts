/**
 * Shared utility functions for agent-orchestrator plugins.
 */

/**
 * POSIX-safe shell escaping: wraps value in single quotes,
 * escaping any embedded single quotes as '\\'' .
 *
 * Safe for use in both `sh -c` and `execFile` contexts.
 */
export function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Escape a string for safe interpolation inside AppleScript double-quoted strings.
 * Handles backslashes and double quotes which would otherwise break or inject.
 */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Validate that a URL starts with http:// or https://.
 * Throws with a descriptive error including the plugin label if invalid.
 */
export function validateUrl(url: string, label: string): void {
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    throw new Error(`[${label}] Invalid url: must be http(s), got "${url}"`);
  }
}
