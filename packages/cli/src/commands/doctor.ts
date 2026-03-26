import type { Command } from "commander";
import chalk from "chalk";
import { findConfigFile, loadConfig, type Notifier, type OrchestratorConfig } from "@composio/ao-core";
import { runRepoScript } from "../lib/script-runner.js";
import { probeGateway, validateToken } from "../lib/openclaw-probe.js";

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

  // Step 1: Probe gateway reachability
  const probe = await probeGateway(url);
  if (!probe.reachable) {
    fail(
      `OpenClaw gateway is not reachable at ${url}. ` +
        `Fix: ensure OpenClaw is running (openclaw status) or fix the URL in your config`,
    );
    return;
  }

  pass(`OpenClaw gateway is reachable at ${url} (HTTP ${probe.httpStatus})`);

  // Step 2: Validate auth token if present
  if (!token) {
    warn(
      "OpenClaw token is not set. Fix: set OPENCLAW_HOOKS_TOKEN env var or add token to notifiers.openclaw in config",
    );
    return;
  }

  const tokenResult = await validateToken(url, token);
  if (!tokenResult.valid) {
    fail(`OpenClaw token validation failed: ${tokenResult.error}`);
    return;
  }

  pass("OpenClaw token is valid");
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
  await registry.loadFromConfig(config);

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
        try {
          const config = loadConfig(configPath);
          await checkNotifierConnectivity(config, fail);

          // 3. Send test notifications if requested
          if (opts.testNotify) {
            await sendTestNotifications(config, fail);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (opts.testNotify) {
            fail(`Notifier checks failed: ${message}`);
          } else {
            warn(`Notifier checks failed: ${message}`);
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
