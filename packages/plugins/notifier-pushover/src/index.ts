import type {
  PluginModule,
  Notifier,
  OrchestratorEvent,
  NotifyAction,
  NotifyContext,
  EventPriority,
} from "@composio/ao-core";

export const manifest = {
  name: "pushover",
  slot: "notifier" as const,
  description: "Notifier plugin: Pushover push notifications",
  version: "0.1.0",
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: "\u{1F6A8}",
  action: "\u{1F449}",
  warning: "\u26A0\uFE0F",
  info: "\u2139\uFE0F",
};

/** Map event priority to Pushover priority (-2 to 2) */
const PUSHOVER_PRIORITY: Record<EventPriority, number> = {
  urgent: 2,
  action: 1,
  warning: 0,
  info: -1,
};

async function sendPushover(
  token: string,
  userKey: string,
  title: string,
  message: string,
  priority: EventPriority,
  url?: string,
  urlTitle?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    token,
    user: userKey,
    title,
    message,
    priority: PUSHOVER_PRIORITY[priority],
    timestamp: Math.floor(Date.now() / 1000),
    html: 1,
  };

  // Pushover emergency priority (2) requires retry and expire
  if (PUSHOVER_PRIORITY[priority] === 2) {
    body.retry = 300; // retry every 5 minutes
    body.expire = 3600; // expire after 1 hour
  }

  if (url) {
    body.url = url;
    if (urlTitle) body.url_title = urlTitle;
  }

  const response = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const respBody = await response.text();
    throw new Error(`Pushover API failed (${response.status}): ${respBody}`);
  }
}

export function create(_config?: Record<string, unknown>): Notifier {
  const appToken = process.env.PUSHOVER_APP_TOKEN;
  const userKey = process.env.PUSHOVER_USER_KEY;

  if (!appToken || !userKey) {
    // eslint-disable-next-line no-console
    console.warn(
      "[notifier-pushover] Missing PUSHOVER_APP_TOKEN or PUSHOVER_USER_KEY \u2014 notifications will be no-ops",
    );
  }

  return {
    name: "pushover",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!appToken || !userKey) return;
      const title = `${PRIORITY_EMOJI[event.priority]} ${event.type} \u2014 ${event.sessionId}`;
      const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
      await sendPushover(appToken, userKey, title, event.message, event.priority, prUrl, "View PR");
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!appToken || !userKey) return;
      const title = `${PRIORITY_EMOJI[event.priority]} ${event.type} \u2014 ${event.sessionId}`;
      const firstUrl = actions.find((a) => a.url);
      await sendPushover(
        appToken,
        userKey,
        title,
        event.message,
        event.priority,
        firstUrl?.url,
        firstUrl?.label,
      );
    },

    async post(message: string, _context?: NotifyContext): Promise<string | null> {
      if (!appToken || !userKey) return null;
      await sendPushover(appToken, userKey, "Agent Orchestrator", message, "info");
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
