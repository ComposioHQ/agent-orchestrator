import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, unlinkSync } from "node:fs";
import { wasRecentlySpawned, markSpawned } from "./dedup.js";
import type { WebhookConfig } from "./config.js";

const execFileAsync = promisify(execFile);

async function runAoSpawn(
  aoBin: string,
  args: string[],
  label: string,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) {
    console.log(`[DRY_RUN] Would run: ${aoBin} ${args.join(" ")}`);
    return true;
  }

  try {
    const { stdout, stderr } = await execFileAsync(aoBin, args, {
      timeout: 30_000,
    });
    console.log(`[OK] ${label}`);
    if (stdout.trim()) console.log(`  stdout: ${stdout.trim()}`);
    if (stderr.trim()) console.log(`  stderr: ${stderr.trim()}`);
    return true;
  } catch (err) {
    console.error(`[ERROR] ${label}:`, err);
    return false;
  }
}

export async function spawnCodingAgent(
  issueIdentifier: string,
  issueTitle: string,
  config: WebhookConfig,
): Promise<void> {
  if (wasRecentlySpawned(issueIdentifier, "code")) {
    console.log(`[SKIP] ${issueIdentifier} (code) — already spawned within dedup window`);
    return;
  }

  console.log(`[SPAWN:CODE] ${issueIdentifier}: "${issueTitle}"`);

  const success = await runAoSpawn(
    config.aoBin,
    ["spawn", config.aoProjectId, issueIdentifier],
    `Coding agent for ${issueIdentifier}`,
    config.dryRun,
  );

  if (success) {
    markSpawned(issueIdentifier, "code");
  }
}

export async function sendMergeInstruction(
  issueIdentifier: string,
  issueTitle: string,
  config: WebhookConfig,
): Promise<void> {
  if (wasRecentlySpawned(issueIdentifier, "merge")) {
    console.log(`[SKIP] ${issueIdentifier} (merge) — already sent within dedup window`);
    return;
  }

  const message = [
    "QA passed. Merge the PR now.",
    "",
    "1. Squash-merge the PR: gh pr merge --squash --delete-branch",
    `2. Move Linear issue ${issueIdentifier} to "Done"`,
    '3. Remove the "agent-working" label if still present',
    '4. Post a comment on the Linear issue: "Merged. QA passed."',
  ].join("\n");

  console.log(`[MERGE] ${issueIdentifier}: "${issueTitle}"`);

  const success = await runAoSpawn(
    config.aoBin,
    ["send", config.aoProjectId, issueIdentifier, message],
    `Merge instruction for ${issueIdentifier}`,
    config.dryRun,
  );

  if (success) {
    markSpawned(issueIdentifier, "merge");
  }
}

export async function spawnTestGenAgent(
  issueIdentifier: string,
  issueTitle: string,
  config: WebhookConfig,
): Promise<void> {
  if (wasRecentlySpawned(issueIdentifier, "test-gen")) {
    console.log(`[SKIP] ${issueIdentifier} (test-gen) — already spawned within dedup window`);
    return;
  }

  const prompt = [
    config.testGenPrompt,
    "",
    "## Target Issue",
    `Issue: ${issueIdentifier}`,
    `Title: ${issueTitle}`,
    "",
    "Generate tests for the changes introduced by this issue. The code has already been merged to main.",
  ].join("\n");

  console.log(`[SPAWN:TEST] ${issueIdentifier}: "${issueTitle}"`);

  const promptFile = `/tmp/ao-testgen-${issueIdentifier}.md`;
  writeFileSync(promptFile, prompt, "utf-8");

  try {
    const success = await runAoSpawn(
      config.aoBin,
      ["spawn", config.aoProjectId, issueIdentifier, "--prompt", promptFile],
      `Test-gen agent for ${issueIdentifier}`,
      config.dryRun,
    );

    if (success) {
      markSpawned(issueIdentifier, "test-gen");
    }
  } finally {
    try {
      unlinkSync(promptFile);
    } catch {
      // best-effort cleanup
    }
  }
}
