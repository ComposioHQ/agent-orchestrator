import type {
  PluginModule,
  Notifier,
  OrchestratorEvent,
  NotifyAction,
  NotifyContext,
  EventPriority,
} from "@composio/ao-core";

export const manifest = {
  name: "ntfy",
  slot: "notifier" as const,
  description: "Notifier plugin: ntfy push notifications",
  version: "0.1.0",
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: "\u{1F6A8}",
  action: "\u{1F449}",
  warning: "\u26A0\uFE0F",
  info: "\u2139\uFE0F",
};

/** Map event priority to ntfy priority (1=min, 5=max) */
const NTFY_PRIORITY: Record<EventPriority, string> = {
  urgent: "5",
  action: "4",
  warning: "3",
  info: "2",
};

const NTFY_TAGS: Record<EventPriority, string> = {
  urgent: "rotating_light",
  action: "point_right",
  warning: "warning",
  info: "information_source",
};

async function postToNtfy(
  baseUrl: string,
  topic: string,
  title: string,
  message: string,
  priority: EventPriority,
  actions?: NotifyAction[],
): Promise<void> {
  const url = `${baseUrl}/${topic}`;
  const headers: Record<string, string> = {
    Title: title,
    Priority: NTFY_PRIORITY[priority],
    Tags: NTFY_TAGS[priority],
  };

  if (actions && actions.length > 0) {
    const ntfyActions = actions
      .filter((a) => a.url)
      .map((a) => `view, ${a.label}, ${a.url}`)
      .join("; ");
    if (ntfyActions) {
      headers.Actions = ntfyActions;
    }
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: message,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ntfy POST failed (${response.status}): ${body}`);
  }
}

export function create(config?: Record<string, unknown>): Notifier {
  const baseUrl = ((config?.url as string) ?? "https://ntfy.sh").replace(/\/+$/, "");
  const topic = config?.topic as string | undefined;

  if (!topic) {
    // eslint-disable-next-line no-console
    console.warn("[notifier-ntfy] No topic configured \u2014 notifications will be no-ops");
  }

  return {
    name: "ntfy",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!topic) return;
      const title = `${PRIORITY_EMOJI[event.priority]} ${event.type} \u2014 ${event.sessionId}`;
      await postToNtfy(baseUrl, topic, title, event.message, event.priority);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!topic) return;
      const title = `${PRIORITY_EMOJI[event.priority]} ${event.type} \u2014 ${event.sessionId}`;
      await postToNtfy(baseUrl, topic, title, event.message, event.priority, actions);
    },

    async post(message: string, _context?: NotifyContext): Promise<string | null> {
      if (!topic) return null;
      await postToNtfy(baseUrl, topic, "Agent Orchestrator", message, "info");
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
