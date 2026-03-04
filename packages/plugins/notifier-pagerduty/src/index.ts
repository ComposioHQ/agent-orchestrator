import type {
  PluginModule,
  Notifier,
  OrchestratorEvent,
  NotifyAction,
  NotifyContext,
  EventPriority,
} from "@composio/ao-core";

export const manifest = {
  name: "pagerduty",
  slot: "notifier" as const,
  description: "Notifier plugin: PagerDuty Events API v2",
  version: "0.1.0",
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: "\u{1F6A8}",
  action: "\u{1F449}",
  warning: "\u26A0\uFE0F",
  info: "\u2139\uFE0F",
};

/** Map event priority to PagerDuty severity */
const PD_SEVERITY: Record<EventPriority, string> = {
  urgent: "critical",
  action: "error",
  warning: "warning",
  info: "info",
};

/** Only trigger PagerDuty for urgent/action priority events */
function shouldTrigger(priority: EventPriority): boolean {
  return priority === "urgent" || priority === "action";
}

async function sendEvent(
  routingKey: string,
  event: OrchestratorEvent,
  links?: Array<{ href: string; text: string }>,
): Promise<void> {
  const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
  const allLinks = [...(links ?? [])];
  if (prUrl) {
    allLinks.push({ href: prUrl, text: "Pull Request" });
  }

  const payload: Record<string, unknown> = {
    routing_key: routingKey,
    event_action: "trigger",
    payload: {
      summary: `${PRIORITY_EMOJI[event.priority]} ${event.type} \u2014 ${event.sessionId}: ${event.message}`,
      source: `ao/${event.projectId}/${event.sessionId}`,
      severity: PD_SEVERITY[event.priority],
      timestamp: event.timestamp.toISOString(),
      component: event.projectId,
      group: event.sessionId,
      custom_details: {
        eventType: event.type,
        priority: event.priority,
        projectId: event.projectId,
        sessionId: event.sessionId,
        message: event.message,
        ...event.data,
      },
    },
    links: allLinks.length > 0 ? allLinks : undefined,
  };

  const response = await fetch("https://events.pagerduty.com/v2/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`PagerDuty API failed (${response.status}): ${body}`);
  }
}

export function create(_config?: Record<string, unknown>): Notifier {
  const routingKey = process.env.PAGERDUTY_ROUTING_KEY;

  if (!routingKey) {
    console.warn(
      "[notifier-pagerduty] Missing PAGERDUTY_ROUTING_KEY \u2014 notifications will be no-ops",
    );
  }

  return {
    name: "pagerduty",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!routingKey || !shouldTrigger(event.priority)) return;
      await sendEvent(routingKey, event);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!routingKey || !shouldTrigger(event.priority)) return;
      const links = actions
        .filter((a) => a.url)
        .map((a) => ({ href: a.url as string, text: a.label }));
      await sendEvent(routingKey, event, links);
    },

    async post(message: string, context?: NotifyContext): Promise<string | null> {
      if (!routingKey) return null;
      // For plain messages, create a minimal trigger event
      const response = await fetch("https://events.pagerduty.com/v2/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routing_key: routingKey,
          event_action: "trigger",
          payload: {
            summary: message,
            source: `ao/${context?.projectId ?? "unknown"}`,
            severity: "info",
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`PagerDuty API failed (${response.status}): ${body}`);
      }
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
