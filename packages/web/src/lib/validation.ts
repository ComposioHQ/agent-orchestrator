/** Validate that a value is a non-empty string within a max length. Returns error message or null. */
export function validateString(
  value: unknown,
  fieldName: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) {
    return `${fieldName} is required`;
  }
  if (typeof value !== "string") {
    return `${fieldName} must be a string`;
  }
  if (value.trim().length === 0) {
    return `${fieldName} must not be empty`;
  }
  if (value.length > maxLength) {
    return `${fieldName} must be at most ${maxLength} characters`;
  }
  return null;
}

/** Validate that a value matches a safe identifier pattern (alphanumeric, hyphens, underscores). */
export function validateIdentifier(
  value: unknown,
  fieldName: string,
  maxLength = 128,
): string | null {
  const strErr = validateString(value, fieldName, maxLength);
  if (strErr) return strErr;
  if (!/^[a-zA-Z0-9_-]+$/.test(value as string)) {
    return `${fieldName} must match [a-zA-Z0-9_-]+`;
  }
  return null;
}

/**
 * Validate that a projectId is a configured project (own property, not prototype chain).
 * Returns an error message or null.
 */
export function validateConfiguredProject(
  projects: Record<string, unknown>,
  projectId: string,
): string | null {
  if (!Object.hasOwn(projects, projectId)) {
    return `Unknown project: ${projectId}`;
  }
  return null;
}

/**
 * Strip control characters (U+0000–U+001F, U+007F–U+009F) from a string.
 * Critical for messages that may be passed to shell-based runtimes (tmux send-keys, etc.)
 * to prevent command injection via control sequences.
 *
 * NOTE: Newline (0x0a) and carriage return (0x0d) are explicitly excluded from stripping
 * to allow reload commands (e.g., "reload\nconfirm") to work correctly.
 */
export function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}
