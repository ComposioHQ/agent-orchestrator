import type {
  PluginModule,
  Notifier,
  OrchestratorEvent,
  EventType,
} from "@composio/ao-core";

export const manifest = {
  name: "openclaw",
  slot: "notifier" as const,
  description: "Notifier plugin: OpenClaw gateway",
  version: "0.1.0",
};

const DEFAULT_EVENTS: ReadonlySet<EventType> = new Set([
  "session.spawned",
  "session.exited",
  "session.killed",
  "session.stuck",
  "session.needs_input",
  "session.errored",
  "pr.created",
  "pr.merged",
  "ci.failing",
  "ci.fix_failed",
  "review.changes_requested",
  "merge.ready",
  "merge.conflicts",
  "summary.all_complete",
]);

/**
 * Returns true if the HTTP status code should be retried.
 * Only 429 (Too Many Requests) and 5xx (server errors) are retryable.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

const FETCH_TIMEOUT_MS = 30_000;

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable response body>";
  }
}

async function postWithRetry(
  url: string,
  body: Record<string, unknown>,
  token: string,
  retries: number,
  retryDelayMs: number,
): Promise<void> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (response.ok) return;

      const text = await safeResponseText(response);
      lastError = new Error(`OpenClaw POST failed (${response.status}): ${text}`);

      if (!isRetryableStatus(response.status)) {
        throw lastError;
      }
    } catch (err) {
      if (err === lastError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    if (attempt < retries) {
      const delay = retryDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

function formatMessage(event: OrchestratorEvent): string {
  const branch =
    typeof event.data["branch"] === "string" ? event.data["branch"] : null;
  const status =
    typeof event.data["status"] === "string" ? event.data["status"] : null;

  const parts: string[] = [
    `[${event.projectId}/${event.sessionId}]`,
  ];

  if (branch) {
    parts.push(`(${branch})`);
  }

  if (status) {
    parts.push(`status=${status}`);
  }

  parts.push(event.message);

  return parts.join(" ");
}

function buildUrl(host: string, port: number): string {
  return `http://${host}:${port}/api/sessions/main/message`;
}

export function create(config?: Record<string, unknown>): Notifier {
  const host = (config?.host as string | undefined) ?? "localhost";
  const port = (config?.port as number | undefined) ?? 8080;
  const hookToken = config?.token as string | undefined;
  const rawRetries = (config?.retries as number) ?? 2;
  const rawDelay = (config?.retryDelayMs as number) ?? 1000;
  const retries = Number.isFinite(rawRetries) ? Math.max(0, rawRetries) : 2;
  const retryDelayMs = Number.isFinite(rawDelay) && rawDelay >= 0 ? rawDelay : 1000;

  // Parse optional event filter
  const rawEvents = config?.events as string[] | undefined;
  const allowedEvents: ReadonlySet<string> =
    Array.isArray(rawEvents) && rawEvents.length > 0
      ? new Set(rawEvents)
      : DEFAULT_EVENTS;

  if (!hookToken) {
    console.warn("[notifier-openclaw] No token configured — notifications will be no-ops");
  }

  const url = buildUrl(host, port);

  return {
    name: "openclaw",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!hookToken) return;
      if (!allowedEvents.has(event.type)) return;

      const text = formatMessage(event);
      await postWithRetry(url, { message: text }, hookToken, retries, retryDelayMs);
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
