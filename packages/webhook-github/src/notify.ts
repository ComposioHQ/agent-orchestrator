import https from "node:https";
import http from "node:http";
import type { Config } from "./config.js";

const EVENT_LABELS: Record<string, { title: string; tags: string; priority: string }> = {
  pull_request: { title: "PR opened", tags: "tada", priority: "4" },
  "pull_request_review.changes_requested": { title: "Changes requested", tags: "memo", priority: "4" },
  "pull_request_review.approved": { title: "PR approved", tags: "white_check_mark", priority: "4" },
  "check_suite.failure": { title: "CI failed", tags: "x", priority: "5" },
  "check_suite.success": { title: "CI passed", tags: "white_check_mark", priority: "3" },
};

/**
 * Send a push notification via ntfy when a webhook event is correlated to a session.
 * Silent-fail: notification delivery should never break the webhook flow.
 */
export function sendNtfy(
  config: Config,
  eventType: string,
  action: string | undefined,
  sessionId: string,
  branch: string,
): void {
  if (!config.ntfyTopic) return;

  const key = action ? `${eventType}.${action}` : eventType;
  const labels = EVENT_LABELS[key] ?? EVENT_LABELS[eventType] ?? {
    title: eventType,
    tags: "bell",
    priority: "3",
  };

  const url = new URL(`/${config.ntfyTopic}`, config.ntfyBaseUrl);
  const transport = url.protocol === "https:" ? https : http;

  const req = transport.request(
    {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: {
        "Title": `${labels.title} — ${sessionId}`,
        "Priority": labels.priority,
        "Tags": labels.tags,
        "Click": `${config.dashboardUrl}/sessions/${encodeURIComponent(sessionId)}`,
      },
    },
    () => {},
  );

  req.once("error", () => {}); // silent-fail
  req.end(`${labels.title} on ${branch} (session ${sessionId})`);
}
