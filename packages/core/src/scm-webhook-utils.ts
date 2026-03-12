import type { SCMWebhookRequest } from "./types.js";

export function getWebhookHeader(
  headers: SCMWebhookRequest["headers"],
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

export function parseWebhookJsonObject(body: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Webhook payload must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function parseWebhookTimestamp(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function parseWebhookBranchRef(ref: unknown): string | undefined {
  if (typeof ref !== "string" || ref.length === 0) return undefined;
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/")) return undefined;
  return ref;
}
