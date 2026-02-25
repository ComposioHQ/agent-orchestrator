import {
  validateUrl,
  type PluginModule,
  type Notifier,
  type OrchestratorEvent,
  type NotifyAction,
  type NotifyContext,
} from "@composio/ao-core";

export const manifest = {
  name: "discord",
  slot: "notifier" as const,
  description: "Notifier plugin: Discord webhook",
  version: "0.1.0",
};

function eventToDiscordMessage(event: OrchestratorEvent): Record<string, unknown> {
  return {
    content: `**${event.type}** • ${event.sessionId}`,
    embeds: [
      {
        title: `${event.projectId} (${event.priority})`,
        description: event.message,
        timestamp: event.timestamp.toISOString(),
        fields: [
          { name: "Session", value: event.sessionId, inline: true },
          { name: "Priority", value: event.priority, inline: true },
        ],
      },
    ],
  };
}

async function post(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord webhook failed (${res.status}): ${body}`);
  }
}

export function create(config?: Record<string, unknown>): Notifier {
  const webhookUrl = config?.webhookUrl as string | undefined;

  if (!webhookUrl) {
    console.warn("[notifier-discord] No webhookUrl configured — notifications will be no-ops");
  } else {
    validateUrl(webhookUrl, "notifier-discord");
  }

  return {
    name: "discord",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!webhookUrl) return;
      await post(webhookUrl, eventToDiscordMessage(event));
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!webhookUrl) return;
      const actionLines = actions.map((a) => `- ${a.label}${a.url ? `: ${a.url}` : ""}`).join("\n");
      const payload = eventToDiscordMessage(event);
      payload["content"] = `${payload["content"] as string}\n${actionLines}`;
      await post(webhookUrl, payload);
    },

    async post(message: string, _context?: NotifyContext): Promise<string | null> {
      if (!webhookUrl) return null;
      await post(webhookUrl, { content: message });
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
