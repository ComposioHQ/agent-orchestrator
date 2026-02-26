import type {
  PluginModule,
  Notifier,
  OrchestratorEvent,
  NotifyAction,
  NotifyContext,
  EventPriority,
} from "@composio/ao-core";

export const manifest = {
  name: "email",
  slot: "notifier" as const,
  description: "Notifier plugin: Email via Resend API",
  version: "0.1.0",
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: "\u{1F6A8}",
  action: "\u{1F449}",
  warning: "\u26A0\uFE0F",
  info: "\u2139\uFE0F",
};

function buildSubject(event: OrchestratorEvent): string {
  return `${PRIORITY_EMOJI[event.priority]} [${event.priority.toUpperCase()}] ${event.type} \u2014 ${event.sessionId}`;
}

function buildHtml(event: OrchestratorEvent, actions?: NotifyAction[]): string {
  const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
  const ciStatus = typeof event.data.ciStatus === "string" ? event.data.ciStatus : undefined;

  let html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px;">
  <h2>${PRIORITY_EMOJI[event.priority]} ${event.type} &mdash; ${event.sessionId}</h2>
  <p>${event.message}</p>
  <table style="border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">Project</td><td>${event.projectId}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">Session</td><td>${event.sessionId}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">Priority</td><td>${event.priority}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">Time</td><td>${event.timestamp.toISOString()}</td></tr>
    ${ciStatus ? `<tr><td style="padding: 4px 12px 4px 0; font-weight: bold;">CI</td><td>${ciStatus}</td></tr>` : ""}
  </table>`;

  if (prUrl) {
    html += `<p><a href="${prUrl}" style="color: #0366d6;">View Pull Request</a></p>`;
  }

  if (actions && actions.length > 0) {
    const links = actions
      .filter((a) => a.url)
      .map(
        (a) =>
          `<a href="${a.url}" style="display:inline-block;padding:8px 16px;margin:4px;background:#0366d6;color:#fff;text-decoration:none;border-radius:4px;">${a.label}</a>`,
      )
      .join(" ");
    if (links) {
      html += `<div style="margin: 16px 0;">${links}</div>`;
    }
  }

  html += `</div>`;
  return html;
}

async function sendEmail(
  apiKey: string,
  from: string,
  to: string[],
  subject: string,
  html: string,
): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend API failed (${response.status}): ${body}`);
  }
}

export function create(config?: Record<string, unknown>): Notifier {
  const apiKey = process.env.RESEND_API_KEY;
  const toRaw = config?.to;
  const to: string[] = Array.isArray(toRaw)
    ? toRaw.filter((v): v is string => typeof v === "string")
    : [];
  const from = (config?.from as string) ?? "Agent Orchestrator <ao@notifications.example.com>";

  if (!apiKey || to.length === 0) {
    console.warn(
      "[notifier-email] Missing RESEND_API_KEY or to addresses \u2014 notifications will be no-ops",
    );
  }

  return {
    name: "email",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!apiKey || to.length === 0) return;
      await sendEmail(apiKey, from, to, buildSubject(event), buildHtml(event));
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!apiKey || to.length === 0) return;
      await sendEmail(apiKey, from, to, buildSubject(event), buildHtml(event, actions));
    },

    async post(message: string, _context?: NotifyContext): Promise<string | null> {
      if (!apiKey || to.length === 0) return null;
      await sendEmail(
        apiKey,
        from,
        to,
        "Agent Orchestrator Notification",
        `<div style="font-family: sans-serif;">${message}</div>`,
      );
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
