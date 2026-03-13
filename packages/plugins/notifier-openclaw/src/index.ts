import {
  type EventPriority,
  type Notifier,
  type NotifyAction,
  type NotifyContext,
  type OrchestratorEvent,
  type PluginModule,
} from "@composio/ao-core";
import { isRetryableHttpStatus, normalizeRetryConfig, validateUrl } from "@composio/ao-core/utils";
import { createHash } from "node:crypto";

export const manifest = {
  name: "openclaw",
  slot: "notifier" as const,
  description: "Notifier plugin: OpenClaw webhook notifications",
  version: "0.1.0",
};

type WakeMode = "now" | "next-heartbeat";

interface OpenClawWebhookPayload {
  message: string;
  event_id: string;
  name?: string;
  sessionKey?: string;
  wakeMode?: WakeMode;
  deliver?: boolean;
}

async function postWithRetry(
  url: string,
  payload: OpenClawWebhookPayload,
  headers: Record<string, string>,
  retries: number,
  retryDelayMs: number,
  context: { sessionId: string },
): Promise<void> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (response.ok) return;

      const body = await response.text();
      lastError = new Error(`OpenClaw webhook failed (${response.status}): ${body}`);

      if (!isRetryableHttpStatus(response.status)) {
        throw lastError;
      }

      if (attempt < retries) {
        console.warn(
          `[notifier-openclaw] Retry ${attempt + 1}/${retries} for session=${context.sessionId} after HTTP ${response.status}`,
        );
      }
    } catch (err) {
      if (err === lastError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < retries) {
        console.warn(
          `[notifier-openclaw] Retry ${attempt + 1}/${retries} for session=${context.sessionId} after network error: ${lastError.message}`,
        );
      }
    }

    if (attempt < retries) {
      const delay = retryDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

function sanitizeSessionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9:_-]/g, "-");
}

function eventHeadline(event: OrchestratorEvent): string {
  const priorityTag: Record<EventPriority, string> = {
    urgent: "URGENT",
    action: "ACTION",
    warning: "WARNING",
    info: "INFO",
  };
  return `[AO ${priorityTag[event.priority]}] ${event.sessionId} ${event.type}`;
}

function stringifyData(data: Record<string, unknown>): string {
  const entries = Object.entries(data);
  if (entries.length === 0) return "";
  return `Context: ${JSON.stringify(data)}`;
}

function formatEscalationMessage(event: OrchestratorEvent): string {
  const parts = [
    eventHeadline(event),
    `Event ID: ${event.id}`,
    event.message,
    stringifyData(event.data),
  ].filter(Boolean);
  return parts.join("\n");
}

function formatActionsLine(actions: NotifyAction[]): string {
  if (actions.length === 0) return "";
  const labels = actions.map((a) => a.label).join(", ");
  return `Actions available: ${labels}`;
}

function stableEventId(parts: string[]): string {
  const input = parts.join("|");
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

export function create(config?: Record<string, unknown>): Notifier {
  const url =
    (typeof config?.url === "string" ? config.url : undefined) ??
    "http://127.0.0.1:18789/hooks/agent";
  const token =
    (typeof config?.token === "string" ? config.token : undefined) ??
    process.env.OPENCLAW_HOOKS_TOKEN;
  const senderName = typeof config?.name === "string" ? config.name : "AO";
  const sessionKeyPrefix =
    typeof config?.sessionKeyPrefix === "string" ? config.sessionKeyPrefix : "hook:ao:";
  const wakeMode: WakeMode = config?.wakeMode === "next-heartbeat" ? "next-heartbeat" : "now";
  const deliver = typeof config?.deliver === "boolean" ? config.deliver : true;
  const idempotencyTtlMs =
    typeof config?.idempotencyTtlMs === "number" && config.idempotencyTtlMs >= 0
      ? config.idempotencyTtlMs
      : 300_000;

  const { retries, retryDelayMs } = normalizeRetryConfig(config);
  const recentEventIds = new Map<string, number>();

  validateUrl(url, "notifier-openclaw");

  if (!token) {
    console.warn(
      "[notifier-openclaw] No token configured (token or OPENCLAW_HOOKS_TOKEN). Sending without Authorization header.",
    );
  }

  function reserveEventId(sessionKey: string, eventId: string): boolean {
    if (idempotencyTtlMs === 0) return true;

    const now = Date.now();
    for (const [key, expiresAt] of recentEventIds.entries()) {
      if (expiresAt <= now) recentEventIds.delete(key);
    }

    const dedupeKey = `${sessionKey}:${eventId}`;
    const expiresAt = recentEventIds.get(dedupeKey);
    if (typeof expiresAt === "number" && expiresAt > now) {
      return false;
    }

    recentEventIds.set(dedupeKey, now + idempotencyTtlMs);
    return true;
  }

  async function sendPayload(payload: OpenClawWebhookPayload, dedupe: boolean): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const sessionKey = payload.sessionKey ?? `${sessionKeyPrefix}default`;
    const sessionId = sessionKey.slice(sessionKeyPrefix.length) || "default";
    if (dedupe && !reserveEventId(sessionKey, payload.event_id)) {
      console.info(
        `[notifier-openclaw] Skipping duplicate escalation event_id=${payload.event_id} session=${sessionId}`,
      );
      return;
    }

    await postWithRetry(url, payload, headers, retries, retryDelayMs, { sessionId });
  }

  return {
    name: "openclaw",

    async notify(event: OrchestratorEvent): Promise<void> {
      const sessionKey = `${sessionKeyPrefix}${sanitizeSessionId(event.sessionId)}`;
      await sendPayload({
        message: formatEscalationMessage(event),
        event_id: event.id,
        name: senderName,
        sessionKey,
        wakeMode,
        deliver,
      }, true);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      const sessionKey = `${sessionKeyPrefix}${sanitizeSessionId(event.sessionId)}`;
      const actionsLine = formatActionsLine(actions);
      const message = [formatEscalationMessage(event), actionsLine].filter(Boolean).join("\n");

      await sendPayload({
        message,
        event_id: event.id,
        name: senderName,
        sessionKey,
        wakeMode,
        deliver,
      }, true);
    },

    async post(message: string, context?: NotifyContext): Promise<string | null> {
      const sessionId = context?.sessionId ? sanitizeSessionId(context.sessionId) : "default";
      const sessionKey = `${sessionKeyPrefix}${sessionId}`;

      await sendPayload({
        message,
        event_id: stableEventId([sessionKey, message]),
        name: senderName,
        sessionKey,
        wakeMode,
        deliver,
      }, false);

      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
