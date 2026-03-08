const OPENCODE_SESSION_ID_RE = /^ses_[A-Za-z0-9_-]+$/;

export function asValidOpenCodeSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return OPENCODE_SESSION_ID_RE.test(trimmed) ? trimmed : undefined;
}
