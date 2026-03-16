/**
 * Normalize NEXT_PUBLIC_BASE_PATH to a Next.js-compatible basePath string.
 * Returns "" when unset/blank, and throws for slash-only root input.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeBasePath(raw) {
  if (raw === null || raw === undefined) return "";

  const trimmed = String(raw).trim();
  if (!trimmed) return "";

  const stripped = trimmed.replace(/^\/+|\/+$/g, "");
  if (!stripped) {
    throw new Error(
      `Invalid NEXT_PUBLIC_BASE_PATH: "${raw}" must include a non-root path segment like "ao" or "/ao".`,
    );
  }

  return `/${stripped}`;
}
