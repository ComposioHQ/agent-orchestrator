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
  name: "teams",
  slot: "notifier" as const,
  description: "Notifier plugin: Microsoft Teams webhook notifications",
  version: "0.1.0",
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: "\u{1F6A8}",
  action: "\u{1F449}",
  warning: "\u26A0\uFE0F",
  info: "\u2139\uFE0F",
};

const PRIORITY_COLOR: Record<EventPriority, string> = {
  urgent: "attention",
  action: "warning",
  warning: "warning",
  info: "default",
};

function buildAdaptiveCard(
  event: OrchestratorEvent,
  actions?: NotifyAction[],
): Record<string, unknown> {
  const body: unknown[] = [
    {
      type: "TextBlock",
      size: "Large",
      weight: "Bolder",
      text: `${PRIORITY_EMOJI[event.priority]} ${event.type} \u2014 ${event.sessionId}`,
      color: PRIORITY_COLOR[event.priority],
    },
    {
      type: "TextBlock",
      text: event.message,
      wrap: true,
    },
    {
      type: "FactSet",
      facts: [
        { title: "Project", value: event.projectId },
        { title: "Session", value: event.sessionId },
        { title: "Priority", value: event.priority },
        { title: "Time", value: event.timestamp.toISOString() },
      ],
    },
  ];

  const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
  if (prUrl) {
    body.push({
      type: "TextBlock",
      text: `[View Pull Request](${prUrl})`,
      wrap: true,
    });
  }

  const cardActions: unknown[] = [];
  if (actions && actions.length > 0) {
    for (const action of actions) {
      if (action.url) {
        cardActions.push({
          type: "Action.OpenUrl",
          title: action.label,
          url: action.url,
        });
      }
    }
  }

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body,
          actions: cardActions.length > 0 ? cardActions : undefined,
        },
      },
    ],
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
      throw new Error(`Teams webhook failed (${response.status}): ${body}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function create(config?: Record<string, unknown>): Notifier {
  const webhookUrl = config?.webhookUrl as string | undefined;

  if (!webhookUrl) {
    // eslint-disable-next-line no-console
    console.warn("[notifier-teams] No webhookUrl configured \u2014 notifications will be no-ops");
  } else {
    validateUrl(webhookUrl, "notifier-teams");
  }

  return {
    name: "teams",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!webhookUrl) return;
      await postToWebhook(webhookUrl, buildAdaptiveCard(event));
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!webhookUrl) return;
      await postToWebhook(webhookUrl, buildAdaptiveCard(event, actions));
    },

    async post(message: string, _context?: NotifyContext): Promise<string | null> {
      if (!webhookUrl) return null;
      await postToWebhook(webhookUrl, {
        type: "message",
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: {
              $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
              type: "AdaptiveCard",
              version: "1.4",
              body: [{ type: "TextBlock", text: message, wrap: true }],
            },
          },
        ],
      });
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
