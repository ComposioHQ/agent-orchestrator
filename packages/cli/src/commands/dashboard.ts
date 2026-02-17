import chalk from "chalk";
import type { Command } from "commander";
import { getConfig, getConfigPath } from "../services/ConfigService.js";
import { PortManager } from "../services/PortManager.js";
import { DashboardManager } from "../services/DashboardManager.js";

export function registerDashboard(program: Command): void {
  program
    .command("dashboard")
    .description("Start the web dashboard")
    .option("-p, --port <port>", "Port to listen on")
    .option("--no-open", "Don't open browser automatically")
    .action(async (opts: { port?: string; open?: boolean }) => {
      const config = getConfig();
      const preferredPort = opts.port ? parseInt(opts.port, 10) : (config.port ?? 3000);

      if (isNaN(preferredPort) || preferredPort < 1 || preferredPort > 65535) {
        console.error(chalk.red("Invalid port number. Must be 1-65535."));
        process.exit(1);
      }

      const portManager = new PortManager();
      const ports = await portManager.allocateServicePorts(preferredPort);

      if (ports.dashboard !== preferredPort) {
        console.log(chalk.yellow(`Port ${preferredPort} in use, using ${ports.dashboard} instead`));
      }

      console.log(chalk.bold(`Starting dashboard on http://localhost:${ports.dashboard}\n`));

      const dashboardManager = new DashboardManager();

      try {
        const child = dashboardManager.start({
          ports,
          configPath: getConfigPath(),
          openBrowser: opts.open !== false,
        });

        child.on("exit", (code) => {
          process.exit(code ?? 0);
        });
      } catch (err) {
        console.error(chalk.red("Could not start dashboard."));
        console.error(chalk.dim(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}
