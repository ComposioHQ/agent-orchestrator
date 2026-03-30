import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import {
  findConfigFile,
  getObservabilityBaseDir,
  loadConfig,
  type Notifier,
  type OrchestratorConfig,
} from "@composio/ao-core";
import { runRepoScript } from "../lib/script-runner.js";
import { detectOpenClawInstallation, validateToken } from "../lib/openclaw-probe.js";
import { importPluginModuleFromSource } from "../lib/plugin-store.js";

// ---------------------------------------------------------------------------
// Helpers — match the PASS / WARN / FAIL style of ao-doctor.sh
// ---------------------------------------------------------------------------

function pass(msg: string): void {
  console.log(`${chalk.green("PASS")} ${msg}`);
}

function warn(msg: string): void {
  console.log(`${chalk.yellow("WARN")} ${msg}`);
}

/** Returns a fail() recorder and a count() getter — local per invocation, no shared state. */
function makeFailCounter(): { fail: (msg: string) => void; count: () => number } {
  let n = 0;
  return {
    fail(msg: string): void {
      n++;
      console.log(`${chalk.red("FAIL")} ${msg}`);
    },
    count(): number {
      return n;
    },
  };
}

// ---------------------------------------------------------------------------
// Notifier connectivity checks (Gap 2)
// ---------------------------------------------------------------------------

interface OpenClawHealthSummary {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureError: string | null;
  totalSent: number;
  totalFailed: number;
}

function formatTimestamp(timestamp: string | null): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

function readOpenClawHealth(config: OrchestratorConfig): OpenClawHealthSummary | null {
  if (!config.configPath) return null;
  const healthPath = join(getObservabilityBaseDir(config.configPath), "openclaw-health.json");
  if (!existsSync(healthPath)) return null;

  try {
    const raw = readFileSync(healthPath, "utf-8");
    return JSON.parse(raw) as OpenClawHealthSummary;
  } catch {
    return null;
  }
}

async function checkOpenClawNotifier(
  config: OrchestratorConfig,
  fail: (msg: string) => void,
): Promise<void> {
  const openclawConfig = config.notifiers?.["openclaw"];
  if (!openclawConfig || openclawConfig.plugin !== "openclaw") {
    warn("OpenClaw notifier is not configured. Fix: run ao setup openclaw");
    return;
  }

  const url =
    (typeof openclawConfig["url"] === "string" ? openclawConfig["url"] : undefined) ??
    "http://127.0.0.1:18789";
  // Resolve ${ENV_VAR} placeholders written by `ao setup openclaw` — the config
  // stores the literal string "${OPENCLAW_HOOKS_TOKEN}" which is truthy but wrong.
  const rawToken = typeof openclawConfig["token"] === "string" ? openclawConfig["token"] : undefined;
  const envVarMatch = rawToken?.match(/^\$\{([^}]+)\}$/);
  const token = (envVarMatch ? process.env[envVarMatch[1]] : rawToken) ?? process.env["OPENCLAW_HOOKS_TOKEN"];

  const installation = await detectOpenClawInstallation(url);
  if (installation.state === "running") {
    pass(
      `OpenClaw gateway detected at ${installation.gatewayUrl} (HTTP ${installation.probe.httpStatus})`,
    );
  } else if (installation.state === "installed-but-stopped") {
    const installHint = installation.binaryPath
      ? `installed at ${installation.binaryPath}`
      : "configured on this machine";
    fail(`OpenClaw is ${installHint} but the gateway is not running at ${installation.gatewayUrl}`);
  } else {
    fail(
      `OpenClaw is not installed locally and the gateway is not reachable at ${installation.gatewayUrl}. ` +
        `Fix: install/start OpenClaw or update the notifier URL`,
    );
  }

  // Step 2: Validate auth token if present
  if (!token) {
    warn(
      "OpenClaw token is not set. Fix: set OPENCLAW_HOOKS_TOKEN env var or add token to notifiers.openclaw in config",
    );
  } else if (installation.state === "running") {
    const tokenResult = await validateToken(url, token);
    if (!tokenResult.valid) {
      fail(`OpenClaw token validation failed: ${tokenResult.error}`);
    } else {
      pass("OpenClaw token is valid");
    }
  }

  const health = readOpenClawHealth(config);
  if (!health) {
    warn("No OpenClaw notification history recorded yet");
    return;
  }

  const lastSuccess = formatTimestamp(health.lastSuccessAt);
  if (lastSuccess) {
    pass(`OpenClaw last successful notification: ${lastSuccess}`);
  } else {
    warn("OpenClaw has not recorded a successful notification yet");
  }

  if (health.lastFailureAt) {
    const lastFailure = formatTimestamp(health.lastFailureAt);
    warn(
      `OpenClaw last failure: ${lastFailure ?? health.lastFailureAt} (${health.lastFailureError ?? "unknown error"})`,
    );
  }

  pass(`OpenClaw notification totals: ${health.totalSent} sent, ${health.totalFailed} failed`);
}

async function checkNotifierConnectivity(
  config: OrchestratorConfig,
  fail: (msg: string) => void,
): Promise<void> {
  console.log(""); // blank line before notifier section
  console.log("Notifier connectivity:");

  const configuredNotifiers = Object.keys(config.notifiers ?? {});
  if (configuredNotifiers.length === 0) {
    warn("No notifiers are configured. Fix: add notifiers to your agent-orchestrator.yaml");
    return;
  }

  // Check OpenClaw specifically (it's the only one we can probe without side effects)
  if (config.notifiers?.["openclaw"]) {
    await checkOpenClawNotifier(config, fail);
  }

  // Report other configured notifiers as present (we can't health-check Slack/desktop/webhook without sending)
  for (const [name, notifierConfig] of Object.entries(config.notifiers ?? {})) {
    if (name === "openclaw") continue; // already checked above
    const plugin = notifierConfig.plugin;
    pass(`${name} notifier is configured (plugin: ${plugin})`);
  }
}

// ---------------------------------------------------------------------------
// Test-notify (Gap 3)
// ---------------------------------------------------------------------------

async function sendTestNotifications(
  config: OrchestratorConfig,
  fail: (msg: string) => void,
): Promise<void> {
  const { createPluginRegistry } = await import("@composio/ao-core");
  const registry = createPluginRegistry();
  await registry.loadFromConfig(config, importPluginModuleFromSource);

  const activeNotifierNames = config.defaults?.notifiers ?? [];
  const configuredNotifiers = Object.keys(config.notifiers ?? {});

  // Combine both lists (defaults + configured) and deduplicate
  const allNames = [...new Set([...activeNotifierNames, ...configuredNotifiers])];

  if (allNames.length === 0) {
    warn("No notifiers to test. Fix: configure notifiers in your agent-orchestrator.yaml");
    return;
  }

  console.log(`\nSending test notification to ${allNames.length} notifier(s)...\n`);

  for (const name of allNames) {
    const notifier = registry.get<Notifier>("notifier", name);
    if (!notifier) {
      warn(`${name}: plugin not loaded (may not be installed)`);
      continue;
    }

    try {
      const testEvent = {
        id: `doctor-test-${Date.now()}`,
        type: "summary.all_complete" as const,
        priority: "info" as const,
        sessionId: "doctor-test",
        projectId: "doctor",
        timestamp: new Date(),
        message: "Test notification from ao doctor --test-notify",
        data: { source: "ao-doctor" },
      };

      await notifier.notify(testEvent);
      pass(`${name}: test notification sent`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fail(`${name}: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Run install, environment, and runtime health checks")
    .option("--fix", "Apply safe fixes for launcher and stale temp issues")
    .option("--test-notify", "Send a test notification through each configured notifier")
    .action(async (opts: { fix?: boolean; testNotify?: boolean }) => {
      const { fail, count: failCount } = makeFailCounter();

      // 1. Run the existing shell-based checks
      const scriptArgs: string[] = [];
      if (opts.fix) {
        scriptArgs.push("--fix");
      }

      let shellExitCode: number;
      try {
        shellExitCode = await runRepoScript("ao-doctor.sh", scriptArgs);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        shellExitCode = 1;
      }

      // 2. Run TypeScript-based notifier checks if a config file exists
      const configPath = findConfigFile();
      if (configPath) {
        let config: ReturnType<typeof loadConfig> | undefined;
        try {
          config = loadConfig(configPath);
          await checkNotifierConnectivity(config, fail);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          warn(`Notifier connectivity check failed: ${message}`);
        }

        // 3. Send test notifications if requested (separate catch for accurate errors)
        if (opts.testNotify && config) {
          try {
            await sendTestNotifications(config, fail);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            fail(`Sending test notifications failed: ${message}`);
          }
        }
      } else if (opts.testNotify) {
        fail("No config file found. Cannot test notifiers without agent-orchestrator.yaml");
      }

      // Exit non-zero if shell checks or notifier checks failed
      if (shellExitCode !== 0 || failCount() > 0) {
        process.exit(shellExitCode || 1);
      }
    });
}
