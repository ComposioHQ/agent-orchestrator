import type {
  PluginModule,
  Notifier,
  OrchestratorEvent,
  NotifyAction,
  NotifyContext,
  EventPriority,
} from "@composio/ao-core";

export const manifest = {
  name: "telegram",
  slot: "notifier" as const,
  description: "Notifier plugin: Telegram bot notifications",
  version: "0.1.0",
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: "\u{1F6A8}",
  action: "\u{1F449}",
  warning: "\u26A0\uFE0F",
  info: "\u2139\uFE0F",
};

/** Escape special chars for Telegram MarkdownV2 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function buildMessage(event: OrchestratorEvent): string {
  const emoji = PRIORITY_EMOJI[event.priority];
  const lines: string[] = [
    `${emoji} *${escapeMarkdownV2(event.type)}* \u2014 ${escapeMarkdownV2(event.sessionId)}`,
    "",
    escapeMarkdownV2(event.message),
    "",
    `*Project:* ${escapeMarkdownV2(event.projectId)}`,
    `*Priority:* ${escapeMarkdownV2(event.priority)}`,
  ];

  const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
  if (prUrl) {
    lines.push(`[View Pull Request](${prUrl})`);
  }

  return lines.join("\n");
}

function buildInlineKeyboard(
  actions: NotifyAction[],
): Array<Array<{ text: string; url?: string; callback_data?: string }>> {
  const buttons = actions
    .filter((a) => a.url || a.callbackEndpoint)
    .map((a) => {
      if (a.url) {
        return { text: a.label, url: a.url };
      }
      return { text: a.label, callback_data: a.callbackEndpoint ?? a.label };
    });

  // One button per row
  return buttons.map((b) => [b]);
}

async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
  replyMarkup?: unknown,
): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "MarkdownV2",
  };
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const respBody = await response.text();
      throw new Error(`Telegram API failed (${response.status}): ${respBody}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function create(config?: Record<string, unknown>): Notifier {
  const chatId = config?.chatId as string | undefined;
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token || !chatId) {
    console.warn(
      "[notifier-telegram] Missing TELEGRAM_BOT_TOKEN or chatId \u2014 notifications will be no-ops",
    );
  }

  return {
    name: "telegram",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!token || !chatId) return;
      await sendTelegram(token, chatId, buildMessage(event));
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!token || !chatId) return;
      const keyboard = buildInlineKeyboard(actions);
      const replyMarkup =
        keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined;
      await sendTelegram(token, chatId, buildMessage(event), replyMarkup);
    },

    async post(message: string, _context?: NotifyContext): Promise<string | null> {
      if (!token || !chatId) return null;
      await sendTelegram(token, chatId, escapeMarkdownV2(message));
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
