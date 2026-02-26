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
  name: "google-chat",
  slot: "notifier" as const,
  description: "Notifier plugin: Google Chat webhook notifications",
  version: "0.1.0",
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: "\u{1F6A8}",
  action: "\u{1F449}",
  warning: "\u26A0\uFE0F",
  info: "\u2139\uFE0F",
};

function buildCard(event: OrchestratorEvent, actions?: NotifyAction[]): Record<string, unknown> {
  const widgets: unknown[] = [
    {
      decoratedText: {
        topLabel: "Event",
        text: `${PRIORITY_EMOJI[event.priority]} ${event.type}`,
      },
    },
    {
      decoratedText: {
        topLabel: "Message",
        text: event.message,
        wrapText: true,
      },
    },
    {
      columns: {
        columnItems: [
          {
            horizontalSizeStyle: "FILL_AVAILABLE_SPACE",
            horizontalAlignment: "START",
            verticalAlignment: "CENTER",
            widgets: [
              { decoratedText: { topLabel: "Project", text: event.projectId } },
            ],
          },
          {
            horizontalSizeStyle: "FILL_AVAILABLE_SPACE",
            horizontalAlignment: "START",
            verticalAlignment: "CENTER",
            widgets: [
              { decoratedText: { topLabel: "Session", text: event.sessionId } },
            ],
          },
        ],
      },
    },
  ];

  const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
  if (prUrl) {
    widgets.push({
      buttonList: {
        buttons: [
          {
            text: "View Pull Request",
            onClick: { openLink: { url: prUrl } },
          },
        ],
      },
    });
  }

  if (actions && actions.length > 0) {
    const buttons = actions
      .filter((a) => a.url)
      .map((a) => ({
        text: a.label,
        onClick: { openLink: { url: a.url } },
      }));
    if (buttons.length > 0) {
      widgets.push({ buttonList: { buttons } });
    }
  }

  return {
    cardsV2: [
      {
        cardId: `ao-${event.id}`,
        card: {
          header: {
            title: `${event.type} \u2014 ${event.sessionId}`,
            subtitle: `Priority: ${event.priority} | ${event.timestamp.toISOString()}`,
          },
          sections: [{ widgets }],
        },
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
    throw new Error(`Google Chat webhook failed (${response.status}): ${body}`);
  }
}

export function create(config?: Record<string, unknown>): Notifier {
  const webhookUrl = config?.webhookUrl as string | undefined;

  if (!webhookUrl) {
    console.warn(
      "[notifier-google-chat] No webhookUrl configured \u2014 notifications will be no-ops",
    );
  } else {
    validateUrl(webhookUrl, "notifier-google-chat");
  }

  return {
    name: "google-chat",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!webhookUrl) return;
      await postToWebhook(webhookUrl, buildCard(event));
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!webhookUrl) return;
      await postToWebhook(webhookUrl, buildCard(event, actions));
    },

    async post(message: string, _context?: NotifyContext): Promise<string | null> {
      if (!webhookUrl) return null;
      await postToWebhook(webhookUrl, { text: message });
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
