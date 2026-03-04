import type {
  PluginModule,
  Notifier,
  OrchestratorEvent,
  NotifyAction,
  NotifyContext,
  EventPriority,
} from "@composio/ao-core";

export const manifest = {
  name: "webex",
  slot: "notifier" as const,
  description: "Notifier plugin: Webex messaging",
  version: "0.1.0",
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: "\u{1F6A8}",
  action: "\u{1F449}",
  warning: "\u26A0\uFE0F",
  info: "\u2139\uFE0F",
};

function buildMarkdown(event: OrchestratorEvent, actions?: NotifyAction[]): string {
  const lines: string[] = [
    `### ${PRIORITY_EMOJI[event.priority]} ${event.type} \u2014 ${event.sessionId}`,
    "",
    event.message,
    "",
    `**Project:** ${event.projectId} | **Priority:** ${event.priority} | **Time:** ${event.timestamp.toISOString()}`,
  ];

  const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
  if (prUrl) {
    lines.push(`\n[View Pull Request](${prUrl})`);
  }

  const ciStatus = typeof event.data.ciStatus === "string" ? event.data.ciStatus : undefined;
  if (ciStatus) {
    lines.push(`**CI Status:** ${ciStatus}`);
  }

  if (actions && actions.length > 0) {
    lines.push("");
    const links = actions
      .filter((a) => a.url)
      .map((a) => `[${a.label}](${a.url})`)
      .join(" | ");
    if (links) {
      lines.push(links);
    }
  }

  return lines.join("\n");
}

async function postToWebex(
  token: string,
  roomId: string,
  markdown: string,
): Promise<void> {
  const response = await fetch("https://webexapis.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      roomId,
      markdown,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Webex API failed (${response.status}): ${body}`);
  }
}

export function create(config?: Record<string, unknown>): Notifier {
  const token = process.env.WEBEX_BOT_TOKEN;
  const roomId = config?.roomId as string | undefined;

  if (!token || !roomId) {
    console.warn(
      "[notifier-webex] Missing WEBEX_BOT_TOKEN or roomId \u2014 notifications will be no-ops",
    );
  }

  return {
    name: "webex",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!token || !roomId) return;
      await postToWebex(token, roomId, buildMarkdown(event));
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!token || !roomId) return;
      await postToWebex(token, roomId, buildMarkdown(event, actions));
    },

    async post(message: string, _context?: NotifyContext): Promise<string | null> {
      if (!token || !roomId) return null;
      await postToWebex(token, roomId, message);
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
