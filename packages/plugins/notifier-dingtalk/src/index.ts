import { createHmac } from "node:crypto";
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
  name: "dingtalk",
  slot: "notifier" as const,
  description: "Notifier plugin: DingTalk webhook notifications",
  version: "0.1.0",
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: "\u{1F6A8}",
  action: "\u{1F449}",
  warning: "\u26A0\uFE0F",
  info: "\u2139\uFE0F",
};

function signUrl(webhookUrl: string, secret: string): string {
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = createHmac("sha256", secret).update(stringToSign).digest("base64");
  const sign = encodeURIComponent(hmac);
  const separator = webhookUrl.includes("?") ? "&" : "?";
  return `${webhookUrl}${separator}timestamp=${timestamp}&sign=${sign}`;
}

function buildMarkdown(event: OrchestratorEvent, actions?: NotifyAction[]): string {
  const lines: string[] = [
    `### ${PRIORITY_EMOJI[event.priority]} ${event.type} \u2014 ${event.sessionId}`,
    "",
    event.message,
    "",
    `- **Project:** ${event.projectId}`,
    `- **Priority:** ${event.priority}`,
    `- **Time:** ${event.timestamp.toISOString()}`,
  ];

  const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
  if (prUrl) {
    lines.push(`- **PR:** [View Pull Request](${prUrl})`);
  }

  if (actions && actions.length > 0) {
    lines.push("");
    for (const action of actions) {
      if (action.url) {
        lines.push(`- [${action.label}](${action.url})`);
      }
    }
  }

  return lines.join("\n");
}

async function postToWebhook(url: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`DingTalk webhook failed (${response.status}): ${body}`);
  }
}

export function create(config?: Record<string, unknown>): Notifier {
  const webhookUrl = config?.webhookUrl as string | undefined;
  const secret = process.env.DINGTALK_SECRET;

  if (!webhookUrl) {
    console.warn(
      "[notifier-dingtalk] No webhookUrl configured \u2014 notifications will be no-ops",
    );
  } else {
    validateUrl(webhookUrl, "notifier-dingtalk");
  }

  function getUrl(): string {
    if (!webhookUrl) return "";
    return secret ? signUrl(webhookUrl, secret) : webhookUrl;
  }

  return {
    name: "dingtalk",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!webhookUrl) return;
      const title = `${PRIORITY_EMOJI[event.priority]} ${event.type} \u2014 ${event.sessionId}`;
      await postToWebhook(getUrl(), {
        msgtype: "markdown",
        markdown: { title, text: buildMarkdown(event) },
      });
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!webhookUrl) return;
      const title = `${PRIORITY_EMOJI[event.priority]} ${event.type} \u2014 ${event.sessionId}`;
      await postToWebhook(getUrl(), {
        msgtype: "markdown",
        markdown: { title, text: buildMarkdown(event, actions) },
      });
    },

    async post(message: string, _context?: NotifyContext): Promise<string | null> {
      if (!webhookUrl) return null;
      await postToWebhook(getUrl(), {
        msgtype: "text",
        text: { content: message },
      });
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
