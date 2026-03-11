import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "@composio/ao-core";
import {
  getManagedServicesStatus,
  installManagedServices,
  runSupervisorLoop,
  startManagedServices,
  stopManagedServices,
  type ManagerPreference,
  type ManagedServicesStatus,
} from "../lib/services.js";

interface ManagerOpts {
  manager?: string;
}

function parseManagerPreference(value?: string): ManagerPreference {
  if (!value) return "auto";
  if (value === "auto" || value === "systemd" || value === "supervisor") {
    return value;
  }
  throw new Error(`Invalid manager "${value}". Use: auto | systemd | supervisor`);
}

function parseTimeout(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid timeout "${value}" (must be a positive integer in ms)`);
  }
  return parsed;
}

function colorProcessState(state: string): string {
  if (state === "active" || state === "running") return chalk.green(state);
  if (state === "missing") return chalk.yellow(state);
  return chalk.red(state);
}

function printServicesStatus(status: ManagedServicesStatus): void {
  console.log(chalk.bold("\nAO Services\n"));
  const managerState = status.managerRunning ? chalk.green("running") : chalk.red("not running");
  console.log(`  Manager: ${chalk.cyan(status.manager)} (${managerState})`);
  console.log(`  Detail:  ${chalk.dim(status.managerDetail)}\n`);

  console.log(
    chalk.dim(
      `  ${"Service".padEnd(22)}${"Process".padEnd(12)}${"Port".padEnd(8)}${"Ready".padEnd(8)}Notes`,
    ),
  );
  console.log(chalk.dim(`  ${"─".repeat(74)}`));

  for (const svc of status.services) {
    const processState = colorProcessState(status.processStates[svc.id]);
    const ready = svc.healthy ? chalk.green("yes") : chalk.red("no");
    const port = String(svc.port);
    const notes = svc.details;
    console.log(
      `  ${svc.id.padEnd(22)}${processState.padEnd(12)}${port.padEnd(8)}${ready.padEnd(8)}${notes}`,
    );
  }

  console.log();
  if (status.allReady) {
    console.log(
      chalk.green(
        "  ✓ Dashboard and both websocket backends are ready (no Connecting... XDA backend outage)",
      ),
    );
  } else {
    console.log(
      chalk.yellow(
        "  ⚠ One or more services are not ready. This can cause dashboard outages or XDA terminal stalls.",
      ),
    );
  }
  console.log();
}

export function registerServices(program: Command): void {
  const services = program
    .command("services")
    .description(
      "Manage supervised dashboard + terminal websocket services (fixes dashboard/XDA ws outages)",
    );

  services
    .command("install")
    .description("Install supervised service definitions (systemd user service or portable fallback)")
    .option("--manager <manager>", "Manager backend: auto|systemd|supervisor", "auto")
    .option("--no-enable", "Install without enabling auto-start (systemd)")
    .option("--no-start", "Install only; do not start services immediately")
    .option("--wait-timeout <ms>", "Readiness wait timeout in ms", "30000")
    .action(async (opts: ManagerOpts & { enable?: boolean; start?: boolean; waitTimeout?: string }) => {
      try {
        const config = loadConfig();
        const manager = parseManagerPreference(opts.manager);
        const timeoutMs = parseTimeout(opts.waitTimeout, 30_000);

        const installResult = await installManagedServices(config, {
          manager,
          enable: opts.enable,
        });
        console.log(chalk.green(`Installed services via ${installResult.manager}:`));
        console.log(chalk.dim(`  ${installResult.detail}\n`));

        if (opts.start !== false) {
          const startResult = await startManagedServices(config, {
            manager: installResult.manager,
            waitTimeoutMs: timeoutMs,
          });
          if (startResult.ready) {
            console.log(chalk.green("Services started and ready.\n"));
          } else {
            console.log(chalk.yellow("Services started, but readiness checks are still failing.\n"));
          }
          printServicesStatus(startResult.status);
        }

        if (installResult.manager === "systemd") {
          console.log(
            chalk.dim(
              "Tip: run `loginctl enable-linger $USER` if you need services to stay up without an active login session.\n",
            ),
          );
        }
      } catch (err) {
        console.error(chalk.red("Failed to install services:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  services
    .command("start")
    .description("Start supervised dashboard and websocket services")
    .option("--manager <manager>", "Manager backend: auto|systemd|supervisor", "auto")
    .option("--wait-timeout <ms>", "Readiness wait timeout in ms", "30000")
    .action(async (opts: ManagerOpts & { waitTimeout?: string }) => {
      try {
        const config = loadConfig();
        const manager = parseManagerPreference(opts.manager);
        const timeoutMs = parseTimeout(opts.waitTimeout, 30_000);
        const result = await startManagedServices(config, { manager, waitTimeoutMs: timeoutMs });
        if (result.ready) {
          console.log(chalk.green("Services started and ready.\n"));
        } else {
          console.log(chalk.yellow("Services started, but readiness checks are still failing.\n"));
        }
        printServicesStatus(result.status);
      } catch (err) {
        console.error(chalk.red("Failed to start services:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  services
    .command("stop")
    .description("Stop supervised dashboard and websocket services")
    .option("--manager <manager>", "Manager backend: auto|systemd|supervisor", "auto")
    .action(async (opts: ManagerOpts) => {
      try {
        const config = loadConfig();
        const manager = parseManagerPreference(opts.manager);
        const result = await stopManagedServices(config, { manager });
        if (result.stopped) {
          console.log(chalk.green(`Stopped services via ${result.manager}.\n`));
        } else {
          console.log(chalk.yellow(`Services were not running under ${result.manager}.\n`));
        }
        printServicesStatus(result.status);
      } catch (err) {
        console.error(chalk.red("Failed to stop services:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  services
    .command("status")
    .description("Show process + health readiness for 3000 / 14800 / 14801 (dashboard + XDA ws)")
    .option("--manager <manager>", "Manager backend: auto|systemd|supervisor", "auto")
    .option("--json", "Output as JSON")
    .option("--strict", "Exit with code 1 when any service is not ready")
    .action(async (opts: ManagerOpts & { json?: boolean; strict?: boolean }) => {
      try {
        const config = loadConfig();
        const manager = parseManagerPreference(opts.manager);
        const status = await getManagedServicesStatus(config, manager);

        if (opts.json) {
          console.log(JSON.stringify(status, null, 2));
        } else {
          printServicesStatus(status);
        }

        if (opts.strict && !status.allReady) {
          process.exit(1);
        }
      } catch (err) {
        console.error(chalk.red("Failed to get services status:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  services
    .command("run-supervisor")
    .description("Internal: run portable AO services supervisor")
    .action(async () => {
      try {
        const config = loadConfig();
        await runSupervisorLoop(config);
      } catch (err) {
        console.error(chalk.red("Supervisor crashed:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
