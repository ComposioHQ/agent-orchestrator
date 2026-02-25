import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface WebhookConfig {
  port: number;
  webhookSecret: string;
  aoProjectId: string;
  aoBin: string;
  dashboardTeamId: string;
  triggerLabel: string;
  dryRun: boolean;
  testGenPrompt: string;
}

export function loadConfig(): WebhookConfig {
  const port = parseInt(process.env["PORT"] ?? "3100", 10);
  const webhookSecret = process.env["LINEAR_WEBHOOK_SECRET"] ?? "";
  const aoProjectId = process.env["AO_PROJECT_ID"] ?? "dashboard";
  const aoBin = process.env["AO_BIN"] ?? "ao";
  const dashboardTeamId =
    process.env["DASHBOARD_TEAM_ID"] ?? "f65d8805-05b4-41d2-a90b-dffe27e24d0b";
  const triggerLabel = process.env["TRIGGER_LABEL"] ?? "agent-ready";
  const dryRun = process.env["DRY_RUN"] === "true";

  const testGenPromptFile = resolve(
    process.env["TEST_GEN_PROMPT_FILE"] ?? resolve(__dirname, "../../test-gen-prompt.md"),
  );

  let testGenPrompt: string;
  try {
    testGenPrompt = readFileSync(testGenPromptFile, "utf-8");
  } catch {
    throw new Error(`Cannot read test-gen prompt: ${testGenPromptFile}`);
  }

  return {
    port,
    webhookSecret,
    aoProjectId,
    aoBin,
    dashboardTeamId,
    triggerLabel,
    dryRun,
    testGenPrompt,
  };
}
