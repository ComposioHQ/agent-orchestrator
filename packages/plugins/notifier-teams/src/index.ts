import {
  validateUrl,
  type PluginModule,
  type Notifier,
  type OrchestratorEvent,
  type NotifyAction,
  type NotifyContext,
} from "@composio/ao-core";

export const manifest = {
  name: "teams",
  slot: "notifier" as const,
  description: "Notifier plugin: Microsoft Teams webhook",
  version: "0.1.0",
};

async function post(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Teams webhook failed (${res.status}): ${body}`);
  }
}

function eventCard(event: OrchestratorEvent, actions?: NotifyAction[]): Record<string, unknown> {
  const sections: Record<string, unknown>[] = [
    {
      activityTitle: `AO ${event.type}`,
      activitySubtitle: `${event.projectId} • ${event.sessionId}`,
      text: event.message,
      facts: [
        { name: "Priority", value: event.priority },
        { name: "Session", value: event.sessionId },
      ],
    },
  ];

  if (actions && actions.length > 0) {
    sections.push({
      text: actions.map((a) => `- ${a.label}${a.url ? `: ${a.url}` : ""}`).join("\n"),
    });
  }

  return {
    "@type": "MessageCard",
    "@context": "https://schema.org/extensions",
    summary: `AO ${event.type}`,
    themeColor: event.priority === "urgent" ? "D32F2F" : "1976D2",
    title: `Agent Orchestrator • ${event.type}`,
    sections,
  };
}

export function create(config?: Record<string, unknown>): Notifier {
  const webhookUrl = config?.webhookUrl as string | undefined;

  if (!webhookUrl) {
    console.warn("[notifier-teams] No webhookUrl configured — notifications will be no-ops");
  } else {
    validateUrl(webhookUrl, "notifier-teams");
  }

  return {
    name: "teams",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!webhookUrl) return;
      await post(webhookUrl, eventCard(event));
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!webhookUrl) return;
      await post(webhookUrl, eventCard(event, actions));
    },

    async post(message: string, _context?: NotifyContext): Promise<string | null> {
      if (!webhookUrl) return null;
      await post(webhookUrl, {
        "@type": "MessageCard",
        "@context": "https://schema.org/extensions",
        text: message,
      });
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
