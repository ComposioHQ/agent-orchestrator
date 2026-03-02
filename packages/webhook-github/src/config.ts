export interface Config {
  webhookSecret: string;
  internalUrl: string; // e.g. http://127.0.0.1:3101
  dataDir: string;
  port: number;
  ntfyTopic: string | null;
  ntfyBaseUrl: string;
  dashboardUrl: string;
}

export function loadConfig(): Config {
  const webhookSecret = process.env["GITHUB_WEBHOOK_SECRET"];
  if (!webhookSecret) throw new Error("GITHUB_WEBHOOK_SECRET is required");

  return {
    webhookSecret,
    internalUrl:
      process.env["AO_INTERNAL_URL"] ?? "http://127.0.0.1:3101",
    dataDir:
      process.env["AO_DATA_DIR"] ?? `${process.env["HOME"]}/.ao-sessions`,
    port: parseInt(process.env["PORT"] ?? "3102", 10),
    ntfyTopic: process.env["NTFY_TOPIC"] ?? null,
    ntfyBaseUrl: process.env["NTFY_BASE_URL"] ?? "https://ntfy.sh",
    dashboardUrl: process.env["DASHBOARD_URL"] ?? "https://agentflow.monster",
  };
}
