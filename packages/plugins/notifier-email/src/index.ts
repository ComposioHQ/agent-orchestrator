import {
  type PluginModule,
  type Notifier,
  type OrchestratorEvent,
  type NotifyAction,
  type NotifyContext,
} from "@composio/ao-core";

export const manifest = {
  name: "email",
  slot: "notifier" as const,
  description: "Notifier plugin: Email via Resend",
  version: "0.1.0",
};

async function sendEmail(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API failed (${res.status}): ${body}`);
  }
}

function formatEvent(event: OrchestratorEvent): { subject: string; text: string } {
  return {
    subject: `[AO][${event.priority}] ${event.type} (${event.sessionId})`,
    text: [
      `Project: ${event.projectId}`,
      `Session: ${event.sessionId}`,
      `Type: ${event.type}`,
      `Priority: ${event.priority}`,
      "",
      event.message,
    ].join("\n"),
  };
}

export function create(config?: Record<string, unknown>): Notifier {
  const apiKey = (config?.apiKey as string | undefined) ?? process.env["RESEND_API_KEY"];
  const from = (config?.from as string | undefined) ?? process.env["AO_EMAIL_FROM"];
  const to = (config?.to as string | undefined) ?? process.env["AO_EMAIL_TO"];

  if (!apiKey || !from || !to) {
    console.warn("[notifier-email] Missing apiKey/from/to — notifications will be no-ops");
  }

  return {
    name: "email",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!apiKey || !from || !to) return;
      const payload = formatEvent(event);
      await sendEmail(apiKey, from, to, payload.subject, payload.text);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!apiKey || !from || !to) return;
      const payload = formatEvent(event);
      const actionText = actions.map((a) => `- ${a.label}${a.url ? `: ${a.url}` : ""}`).join("\n");
      await sendEmail(apiKey, from, to, payload.subject, `${payload.text}\n\nActions:\n${actionText}`);
    },

    async post(message: string, context?: NotifyContext): Promise<string | null> {
      if (!apiKey || !from || !to) return null;
      const subject = `[AO] Message${context?.sessionId ? ` (${context.sessionId})` : ""}`;
      await sendEmail(apiKey, from, to, subject, message);
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
