import {
  validateUrl,
  type PluginModule,
  type Notifier,
  type OrchestratorEvent,
  type NotifyAction,
  type NotifyContext,
  type EventPriority,
} from "@composio/ao-core";

export const manifest = {
  name: "mattermost",
  slot: "notifier" as const,
  description: "Notifier plugin: Mattermost webhook notifications",
  version: "0.1.0",
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: "\u{1F6A8}",
  action: "\u{1F449}",
  warning: "\u26A0\uFE0F",
  info: "\u2139\uFE0F",
};

const PRIORITY_COLOR: Record<EventPriority, string> = {
  urgent: "#FF0000",
  action: "#FF9900",
  warning: "#FFCC00",
  info: "#3498DB",
};

function buildPayload(
  event: OrchestratorEvent,
  actions?: NotifyAction[],
): Record<string, unknown> {
  const fallback = `${PRIORITY_EMOJI[event.priority]} ${event.type} \u2014 ${event.sessionId}: ${event.message}`;

  let text = event.message;

  const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
  if (prUrl) {
    text += `\n[View Pull Request](${prUrl})`;
  }

  if (actions && actions.length > 0) {
    const links = actions
      .filter((a) => a.url)
      .map((a) => `[${a.label}](${a.url})`)
      .join(" | ");
    if (links) {
      text += `\n${links}`;
    }
  }

  return {
    text: fallback,
    attachments: [
      {
        fallback,
        color: PRIORITY_COLOR[event.priority],
        title: `${PRIORITY_EMOJI[event.priority]} ${event.type} \u2014 ${event.sessionId}`,
        text,
        fields: [
          { short: true, title: "Project", value: event.projectId },
          { short: true, title: "Priority", value: event.priority },
        ],
        ts: Math.floor(event.timestamp.getTime() / 1000),
      },
    ],
  };
}

async function postToWebhook(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Mattermost webhook failed (${response.status}): ${body}`);
  }
}

export function create(config?: Record<string, unknown>): Notifier {
  const webhookUrl = config?.webhookUrl as string | undefined;
  const channel = config?.channel as string | undefined;
  const username = (config?.username as string) ?? "Agent Orchestrator";

  if (!webhookUrl) {
    console.warn(
      "[notifier-mattermost] No webhookUrl configured \u2014 notifications will be no-ops",
    );
  } else {
    validateUrl(webhookUrl, "notifier-mattermost");
  }

  return {
    name: "mattermost",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!webhookUrl) return;
      const payload: Record<string, unknown> = { ...buildPayload(event), username };
      if (channel) payload.channel = channel;
      await postToWebhook(webhookUrl, payload);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!webhookUrl) return;
      const payload: Record<string, unknown> = { ...buildPayload(event, actions), username };
      if (channel) payload.channel = channel;
      await postToWebhook(webhookUrl, payload);
    },

    async post(message: string, context?: NotifyContext): Promise<string | null> {
      if (!webhookUrl) return null;
      const payload: Record<string, unknown> = { text: message, username };
      const ch = context?.channel ?? channel;
      if (ch) payload.channel = ch;
      await postToWebhook(webhookUrl, payload);
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
