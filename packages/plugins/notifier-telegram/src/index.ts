import {
  type PluginModule,
  type Notifier,
  type OrchestratorEvent,
  type NotifyAction,
  type NotifyContext,
} from "@composio/ao-core";

export const manifest = {
  name: "telegram",
  slot: "notifier" as const,
  description: "Notifier plugin: Telegram Bot API",
  version: "0.1.0",
};

async function send(
  botToken: string,
  chatId: string,
  text: string,
  parseMode: string,
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API failed (${res.status}): ${body}`);
  }
}

function eventText(event: OrchestratorEvent): string {
  return [
    `*${event.type}*`,
    `Project: ${event.projectId}`,
    `Session: ${event.sessionId}`,
    `Priority: ${event.priority}`,
    "",
    event.message,
  ].join("\n");
}

export function create(config?: Record<string, unknown>): Notifier {
  const botToken = config?.botToken as string | undefined;
  const chatId = config?.chatId as string | undefined;
  const parseMode = (config?.parseMode as string | undefined) ?? "Markdown";

  if (!botToken || !chatId) {
    console.warn(
      "[notifier-telegram] Missing botToken or chatId — notifications will be no-ops",
    );
  }

  return {
    name: "telegram",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!botToken || !chatId) return;
      await send(botToken, chatId, eventText(event), parseMode);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!botToken || !chatId) return;
      const actionsText = actions.map((a) => `- ${a.label}${a.url ? `: ${a.url}` : ""}`).join("\n");
      await send(botToken, chatId, `${eventText(event)}\n\n${actionsText}`, parseMode);
    },

    async post(message: string, _context?: NotifyContext): Promise<string | null> {
      if (!botToken || !chatId) return null;
      await send(botToken, chatId, message, parseMode);
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
