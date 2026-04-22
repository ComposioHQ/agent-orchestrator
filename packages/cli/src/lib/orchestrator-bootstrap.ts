/**
 * Orchestrator bootstrap — shared startup logic for `ao start`.
 *
 * Launches the dashboard (unless --no-dashboard), spins up the lifecycle worker,
 * and creates/reuses/restores an orchestrator session. Used by both the
 * normal and URL-based start flows.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import chalk from "chalk";
import ora from "ora";
import {
  generateOrchestratorPrompt,
  getOrchestratorSessionId,
  type OrchestratorConfig,
  type ProjectConfig,
} from "@aoagents/ao-core";
import { getSessionManager } from "./create-session-manager.js";
import { ensureLifecycleWorker } from "./lifecycle-service.js";
import {
  findWebDir,
  waitForPortAndOpen,
  isPortAvailable,
  findFreePort,
  MAX_PORT_SCAN,
} from "./web-dir.js";
import { rebuildDashboardProductionArtifacts } from "./dashboard-rebuild.js";
import { preflight } from "./preflight.js";
import { preventIdleSleep } from "./prevent-sleep.js";
import { applyOpenClawCredentials } from "./credential-resolver.js";
import { detectOpenClawInstallation } from "./openclaw-probe.js";
import { DEFAULT_PORT } from "./constants.js";
import { projectSessionUrl } from "./routes.js";
import { ensureTmux } from "./installer.js";
import { startDashboard } from "./dashboard-bootstrap.js";

async function warnAboutOpenClawStatus(config: OrchestratorConfig): Promise<void> {
  const openclawConfig = config.notifiers?.["openclaw"];
  const openclawConfigured =
    openclawConfig !== null && openclawConfig !== undefined &&
    typeof openclawConfig === "object" &&
    openclawConfig.plugin === "openclaw";
  const configuredUrl =
    openclawConfigured && typeof openclawConfig.url === "string" ? openclawConfig.url : undefined;

  try {
    const installation = configuredUrl
      ? await detectOpenClawInstallation(configuredUrl)
      : await detectOpenClawInstallation();

    if (openclawConfigured) {
      if (installation.state !== "running") {
        console.log(
          chalk.yellow(
            `⚠ OpenClaw is configured but the gateway is not reachable at ${installation.gatewayUrl}. Notifications may fail until it is running.`,
          ),
        );
      }
      return;
    }

    if (installation.state === "running") {
      console.log(
        chalk.yellow(
          `⚠ OpenClaw is running at ${installation.gatewayUrl} but AO is not configured to use it. Run \`ao setup openclaw\` if you want OpenClaw notifications.`,
        ),
      );
    }
  } catch {
    // OpenClaw probing is advisory for `ao start`; never block startup on it.
  }
}

export interface RunStartupOptions {
  dashboard?: boolean;
  orchestrator?: boolean;
  rebuild?: boolean;
  dev?: boolean;
}

/**
 * Shared startup logic: launch dashboard + orchestrator session, print summary.
 * Used by both normal and URL-based start flows.
 */
export async function runStartup(
  config: OrchestratorConfig,
  projectId: string,
  project: ProjectConfig,
  opts?: RunStartupOptions,
): Promise<number> {
  // Ensure tmux is available before doing anything — covers all entry paths
  // (normal start, URL start, retry with existing config)
  const runtime = config.defaults?.runtime ?? "tmux";
  if (runtime === "tmux") {
    await ensureTmux();
  }
  await warnAboutOpenClawStatus(config);

  // Prevent macOS idle sleep while AO is running (if enabled in config)
  // Uses caffeinate -i -w <pid> to hold an assertion tied to this process lifetime.
  // No-op on non-macOS platforms.
  if (config.power?.preventIdleSleep !== false) {
    const sleepHandle = preventIdleSleep();
    if (sleepHandle) {
      console.log(chalk.dim("  Preventing macOS idle sleep while AO is running"));
    }
  }

  // Only inject OpenClaw credentials when the project actually uses OpenClaw.
  // This avoids exposing API keys to projects/plugins that don't need them.
  const openclawNotifier = config.notifiers?.["openclaw"];
  const hasOpenClaw =
    openclawNotifier !== null && openclawNotifier !== undefined &&
    typeof openclawNotifier === "object" && openclawNotifier.plugin === "openclaw";
  if (hasOpenClaw) {
    const injectedKeys = applyOpenClawCredentials();
    if (injectedKeys.length > 0) {
      const names = injectedKeys.map((k) => k.key).join(", ");
      console.log(chalk.dim(`  Resolved from OpenClaw config: ${names}`));
    }
  }

  // Start the lifecycle worker unless both dashboard and orchestrator are
  // explicitly disabled (e.g. `ao start --no-dashboard --no-orchestrator`).
  const shouldStartLifecycle = opts?.dashboard !== false || opts?.orchestrator !== false;
  let lifecycleStatus: Awaited<ReturnType<typeof ensureLifecycleWorker>> | null = null;
  let port = config.port ?? DEFAULT_PORT;
  console.log(chalk.bold(`\nStarting orchestrator for ${chalk.cyan(project.name)}\n`));

  const spinner = ora();
  let dashboardProcess: ChildProcess | null = null;
  let restored = false;

  // Start dashboard (unless --no-dashboard)
  if (opts?.dashboard !== false) {
    if (!(await isPortAvailable(port))) {
      const newPort = await findFreePort(port + 1);
      if (newPort === null) {
        throw new Error(
          `Port ${port} is busy and no free port found in range ${port + 1}–${port + MAX_PORT_SCAN}. Free port ${port} or set a different 'port' in agent-orchestrator.yaml.`,
        );
      }
      console.log(chalk.yellow(`Port ${port} is busy — using ${newPort} instead.`));
      port = newPort;
    }
    const webDir = findWebDir(); // throws with install-specific guidance if not found
    // Dev mode (HMR) only works in the monorepo where `server/` source exists.
    // For npm installs, --dev is silently ignored and production server runs,
    // so preflight must still verify production artifacts exist.
    const isMonorepo = existsSync(resolve(webDir, "server"));
    const willUseDevServer = isMonorepo && opts?.dev === true;
    if (opts?.rebuild) {
      await rebuildDashboardProductionArtifacts(webDir);
    } else if (!willUseDevServer) {
      await preflight.checkBuilt(webDir);
    }

    spinner.start("Starting dashboard");
    dashboardProcess = await startDashboard(
      port,
      webDir,
      config.configPath,
      config.terminalPort,
      config.directTerminalPort,
      opts?.dev,
    );
    spinner.succeed(`Dashboard starting on http://localhost:${port}`);
    console.log(chalk.dim("  (Dashboard will be ready in a few seconds)\n"));
  }

  if (shouldStartLifecycle) {
    try {
      spinner.start("Starting lifecycle worker");
      lifecycleStatus = await ensureLifecycleWorker(config, projectId);
      spinner.succeed(
        lifecycleStatus.started
          ? "Lifecycle polling started"
          : "Lifecycle polling already running",
      );
    } catch (err) {
      spinner.fail("Lifecycle worker failed to start");
      if (dashboardProcess) {
        dashboardProcess.kill();
      }
      throw new Error(
        `Failed to start lifecycle worker: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  let selectedOrchestratorId: string | null = null;

  if (opts?.orchestrator !== false) {
    const sm = await getSessionManager(config);

    try {
      spinner.start("Ensuring orchestrator session");
      const systemPrompt = generateOrchestratorPrompt({ config, projectId, project });
      const before = await sm.get(getOrchestratorSessionId(project));
      const session = await sm.ensureOrchestrator({ projectId, systemPrompt });
      selectedOrchestratorId = session.id;
      restored = Boolean(session.restoredAt);
      if (before && session.id === before.id && !restored) {
        spinner.succeed(`Using orchestrator session: ${session.id}`);
      } else if (restored) {
        spinner.succeed(`Restored orchestrator session: ${session.id}`);
      } else {
        spinner.succeed(`Orchestrator session ready: ${session.id}`);
      }
    } catch (err) {
      spinner.fail("Orchestrator setup failed");
      if (dashboardProcess) {
        dashboardProcess.kill();
      }
      throw new Error(
        `Failed to setup orchestrator: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  // Print summary
  console.log(chalk.bold.green("\n✓ Startup complete\n"));

  if (opts?.dashboard !== false) {
    console.log(chalk.cyan("Dashboard:"), `http://localhost:${port}`);
  }

  if (shouldStartLifecycle && lifecycleStatus) {
    const lifecycleLabel = lifecycleStatus.started ? "started" : "already running";
    console.log(chalk.cyan("Lifecycle:"), lifecycleLabel);
  }

  if (opts?.orchestrator !== false && selectedOrchestratorId) {
    const restoreNote = restored ? " (restored)" : "";
    const target =
      opts?.dashboard !== false
        ? projectSessionUrl(port, projectId, selectedOrchestratorId)
        : `ao session attach ${selectedOrchestratorId}`;
    console.log(chalk.cyan("Orchestrator:"), `${target}${restoreNote}`);
  }

  console.log(chalk.dim(`Config: ${config.configPath}`));

  // Auto-open browser once the server is ready.
  // Navigate directly to the deterministic main orchestrator when one is available.
  // Polls the port instead of using a fixed delay — deterministic and works regardless of
  // how long Next.js takes to compile. AbortController cancels polling on early exit.
  let openAbort: AbortController | undefined;
  if (opts?.dashboard !== false) {
    openAbort = new AbortController();
    const orchestratorUrl = selectedOrchestratorId
      ? projectSessionUrl(port, projectId, selectedOrchestratorId)
      : `http://localhost:${port}`;
    void waitForPortAndOpen(port, orchestratorUrl, openAbort.signal);
  }

  // Keep dashboard process alive if it was started
  if (dashboardProcess) {
    // Kill the dashboard child when the parent exits for any reason
    // (Ctrl+C, SIGTERM from `ao stop`, normal exit, etc.).
    // We use the `exit` event instead of SIGINT/SIGTERM to avoid
    // conflicting with the shutdown handler in registerStart that
    // flushes lifecycle state and calls process.exit() with the
    // correct exit code (130 for SIGINT, 0 for SIGTERM).
    /* c8 ignore start -- exit handler only fires on process termination */
    const killDashboardChild = (): void => {
      try {
        dashboardProcess?.kill("SIGTERM");
      } catch {
        // already dead
      }
    };
    /* c8 ignore stop */
    process.on("exit", killDashboardChild);

    dashboardProcess.on("exit", (code) => {
      process.removeListener("exit", killDashboardChild);
      if (openAbort) openAbort.abort();
      if (code !== 0 && code !== null) {
        console.error(chalk.red(`Dashboard exited with code ${code}`));
      }
      process.exit(code ?? 0);
    });
  }

  return port;
}
