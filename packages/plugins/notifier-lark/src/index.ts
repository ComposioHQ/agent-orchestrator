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
  name: "lark",
  slot: "notifier" as const,
  description: "Notifier plugin: Lark (Feishu) webhook notifications",
  version: "0.1.0",
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: "\u{1F6A8}",
  action: "\u{1F449}",
  warning: "\u26A0\uFE0F",
  info: "\u2139\uFE0F",
};

const PRIORITY_COLOR: Record<EventPriority, string> = {
  urgent: "red",
  action: "orange",
  warning: "yellow",
  info: "blue",
};

function buildCard(event: OrchestratorEvent, actions?: NotifyAction[]): Record<string, unknown> {
  const elements: unknown[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: event.message,
      },
    },
    {
      tag: "div",
      fields: [
        {
          is_short: true,
          text: { tag: "lark_md", content: `**Project:** ${event.projectId}` },
        },
        {
          is_short: true,
          text: { tag: "lark_md", content: `**Session:** ${event.sessionId}` },
        },
        {
          is_short: true,
          text: { tag: "lark_md", content: `**Priority:** ${event.priority}` },
        },
        {
          is_short: true,
          text: {
            tag: "lark_md",
            content: `**Time:** ${event.timestamp.toISOString()}`,
          },
        },
      ],
    },
  ];

  const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
  const actionButtons: unknown[] = [];

  if (prUrl) {
    actionButtons.push({
      tag: "button",
      text: { tag: "plain_text", content: "View Pull Request" },
      url: prUrl,
      type: "primary",
    });
  }

  if (actions && actions.length > 0) {
    for (const action of actions) {
      if (action.url) {
        actionButtons.push({
          tag: "button",
          text: { tag: "plain_text", content: action.label },
          url: action.url,
          type: "default",
        });
      }
    }
  }

  if (actionButtons.length > 0) {
    elements.push({
      tag: "action",
      actions: actionButtons,
    });
  }

  return {
    msg_type: "interactive",
    card: {
      header: {
        title: {
          tag: "plain_text",
          content: `${PRIORITY_EMOJI[event.priority]} ${event.type} \u2014 ${event.sessionId}`,
        },
        template: PRIORITY_COLOR[event.priority],
      },
      elements,
    },
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
    throw new Error(`Lark webhook failed (${response.status}): ${body}`);
  }
}

export function create(config?: Record<string, unknown>): Notifier {
  const webhookUrl = config?.webhookUrl as string | undefined;

  if (!webhookUrl) {
    console.warn("[notifier-lark] No webhookUrl configured \u2014 notifications will be no-ops");
  } else {
    validateUrl(webhookUrl, "notifier-lark");
  }

  return {
    name: "lark",

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
      await postToWebhook(webhookUrl, {
        msg_type: "text",
        content: { text: message },
      });
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
