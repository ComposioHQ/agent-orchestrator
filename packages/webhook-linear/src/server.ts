import express from "express";
import { loadConfig } from "./config.js";
import { verifySignature } from "./verify.js";
import { wasLabelAdded, wasMovedToCompleted } from "./events.js";
import { spawnCodingAgent, spawnTestGenAgent } from "./spawn.js";
import { cleanup, entries } from "./dedup.js";
import type { LinearWebhookPayload } from "./types.js";

const config = loadConfig();
const app = express();

app.use("/webhook/linear", express.raw({ type: "application/json" }));

app.post("/webhook/linear", (req, res) => {
  const body = req.body as Buffer;
  const signature = req.headers["linear-signature"] as string | undefined;

  if (!verifySignature(body, signature, config.webhookSecret)) {
    console.warn("[REJECT] Invalid webhook signature");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  let payload: LinearWebhookPayload;
  try {
    payload = JSON.parse(body.toString("utf-8")) as LinearWebhookPayload;
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  res.status(200).json({ ok: true });

  if (payload.type !== "Issue" || payload.action !== "update") return;
  if (payload.data.team?.id !== config.dashboardTeamId) return;

  const { identifier, title } = payload.data;

  if (wasLabelAdded(payload, config.triggerLabel)) {
    console.log(`[EVENT] ${identifier} — label "${config.triggerLabel}" added`);
    spawnCodingAgent(identifier, title, config).catch((err: unknown) =>
      console.error(`[ERROR] spawnCodingAgent(${identifier}):`, err),
    );
    return;
  }

  if (wasMovedToCompleted(payload)) {
    const stateName = payload.data.state?.name ?? "Done";
    const prevName = payload.updatedFrom?.state?.name ?? "unknown";
    console.log(`[EVENT] ${identifier} → ${stateName} (was: ${prevName})`);
    spawnTestGenAgent(identifier, title, config).catch((err: unknown) =>
      console.error(`[ERROR] spawnTestGenAgent(${identifier}):`, err),
    );
  }
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    project: config.aoProjectId,
    teamId: config.dashboardTeamId,
    triggerLabel: config.triggerLabel,
    dryRun: config.dryRun,
    recentSpawns: Object.fromEntries(entries()),
  });
});

const cleanupInterval = setInterval(cleanup, 60_000);

const server = app.listen(config.port, () => {
  console.log(`[ao-linear-webhook] Listening on :${config.port}`);
  console.log(`  Project:       ${config.aoProjectId}`);
  console.log(`  Team:          ${config.dashboardTeamId}`);
  console.log(`  Trigger label: ${config.triggerLabel}`);
  console.log(`  Dry run:       ${config.dryRun}`);
});

process.once("SIGTERM", () => {
  clearInterval(cleanupInterval);
  server.close();
});
