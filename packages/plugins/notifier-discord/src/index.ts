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
  name: "discord",
  slot: "notifier" as const,
  description: "Notifier plugin: Discord webhook notifications",
  version: "0.1.0",
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: "\u{1F6A8}",
  action: "\u{1F449}",
  warning: "\u26A0\uFE0F",
  info: "\u2139\uFE0F",
};

const PRIORITY_COLOR: Record<EventPriority, number> = {
  urgent: 0xff0000,
  action: 0xff9900,
  warning: 0xffcc00,
  info: 0x3498db,
};

function buildEmbed(event: OrchestratorEvent, actions?: NotifyAction[]): Record<string, unknown> {
  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: "Project", value: event.projectId, inline: true },
    { name: "Session", value: event.sessionId, inline: true },
    { name: "Priority", value: event.priority, inline: true },
  ];

  const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
  if (prUrl) {
    fields.push({ name: "Pull Request", value: `[View PR](${prUrl})`, inline: false });
  }

  const ciStatus = typeof event.data.ciStatus === "string" ? event.data.ciStatus : undefined;
  if (ciStatus) {
    fields.push({ name: "CI Status", value: ciStatus, inline: true });
  }

  let description = event.message;
  if (actions && actions.length > 0) {
    const links = actions
      .filter((a) => a.url)
      .map((a) => `[${a.label}](${a.url})`)
      .join(" | ");
    if (links) {
      description += `\n\n${links}`;
    }
  }

  return {
    title: `${PRIORITY_EMOJI[event.priority]} ${event.type} \u2014 ${event.sessionId}`,
    description,
    color: PRIORITY_COLOR[event.priority],
    fields,
    timestamp: event.timestamp.toISOString(),
  };
}

async function postToWebhook(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord webhook failed (${response.status}): ${body}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function create(config?: Record<string, unknown>): Notifier {
  const webhookUrl = config?.webhookUrl as string | undefined;

  if (!webhookUrl) {
    console.warn("[notifier-discord] No webhookUrl configured \u2014 notifications will be no-ops");
  } else {
    validateUrl(webhookUrl, "notifier-discord");
  }

  return {
    name: "discord",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!webhookUrl) return;
      await postToWebhook(webhookUrl, { embeds: [buildEmbed(event)] });
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!webhookUrl) return;
      await postToWebhook(webhookUrl, { embeds: [buildEmbed(event, actions)] });
    },

    async post(message: string, _context?: NotifyContext): Promise<string | null> {
      if (!webhookUrl) return null;
      await postToWebhook(webhookUrl, { content: message });
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
