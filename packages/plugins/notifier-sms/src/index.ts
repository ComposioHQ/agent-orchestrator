import type {
  PluginModule,
  Notifier,
  OrchestratorEvent,
  NotifyAction,
  NotifyContext,
  EventPriority,
} from "@composio/ao-core";

export const manifest = {
  name: "sms",
  slot: "notifier" as const,
  description: "Notifier plugin: SMS via Twilio",
  version: "0.1.0",
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: "\u{1F6A8}",
  action: "\u{1F449}",
  warning: "\u26A0\uFE0F",
  info: "\u2139\uFE0F",
};

function buildSmsBody(event: OrchestratorEvent, actions?: NotifyAction[]): string {
  const lines: string[] = [
    `${PRIORITY_EMOJI[event.priority]} ${event.type} \u2014 ${event.sessionId}`,
    event.message,
    `Project: ${event.projectId}`,
  ];

  const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
  if (prUrl) {
    lines.push(`PR: ${prUrl}`);
  }

  if (actions && actions.length > 0) {
    const links = actions
      .filter((a) => a.url)
      .map((a) => `${a.label}: ${a.url}`);
    lines.push(...links);
  }

  // SMS has a 1600 char limit for long messages; truncate if needed
  const full = lines.join("\n");
  if (full.length > 1500) {
    return full.slice(0, 1497) + "...";
  }
  return full;
}

async function sendSms(
  accountSid: string,
  authToken: string,
  from: string,
  to: string,
  body: string,
): Promise<void> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const credentials = btoa(`${accountSid}:${authToken}`);

  const params = new URLSearchParams();
  params.set("To", to);
  params.set("From", from);
  params.set("Body", body);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const respBody = await response.text();
    throw new Error(`Twilio API failed (${response.status}): ${respBody}`);
  }
}

export function create(config?: Record<string, unknown>): Notifier {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const to = config?.to as string | undefined;
  const from = config?.from as string | undefined;

  if (!accountSid || !authToken || !to || !from) {
    // eslint-disable-next-line no-console
    console.warn(
      "[notifier-sms] Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, to, or from \u2014 notifications will be no-ops",
    );
  }

  return {
    name: "sms",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!accountSid || !authToken || !to || !from) return;
      await sendSms(accountSid, authToken, from, to, buildSmsBody(event));
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!accountSid || !authToken || !to || !from) return;
      await sendSms(accountSid, authToken, from, to, buildSmsBody(event, actions));
    },

    async post(message: string, _context?: NotifyContext): Promise<string | null> {
      if (!accountSid || !authToken || !to || !from) return null;
      // Truncate if needed
      const body = message.length > 1500 ? message.slice(0, 1497) + "..." : message;
      await sendSms(accountSid, authToken, from, to, body);
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
