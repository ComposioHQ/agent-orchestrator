import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "@composio/ao-core";
import { findWebDir } from "../lib/web-dir.js";

export function registerDashboard(program: Command): void {
  program
    .command("dashboard")
    .description("Start the web dashboard")
    .option("-p, --port <port>", "Port to listen on")
    .option("--no-open", "Don't open browser automatically")
    .action(async (opts: { port?: string; open?: boolean }) => {
      const config = loadConfig();
      const port = opts.port ? parseInt(opts.port, 10) : config.port;

      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(chalk.red("Invalid port number. Must be 1-65535."));
        process.exit(1);
      }

      console.log(chalk.bold(`Starting dashboard on http://localhost:${port}\n`));

      const webDir = findWebDir();

      if (!existsSync(resolve(webDir, "package.json"))) {
        console.error(
          chalk.red(
            "Could not find @composio/ao-web package.\n" +
              "Ensure it is installed: pnpm install",
          ),
        );
        process.exit(1);
      }

      const child = spawn("npx", ["next", "dev", "-p", String(port)], {
        cwd: webDir,
        stdio: "inherit",
      });

      child.on("error", (err) => {
        console.error(chalk.red("Could not start dashboard. Ensure Next.js is installed."));
        console.error(chalk.dim(String(err)));
        process.exit(1);
      });

      let browserTimer: ReturnType<typeof setTimeout> | undefined;

      if (opts.open !== false) {
        browserTimer = setTimeout(() => {
          const browser = spawn("open", [`http://localhost:${port}`], {
            stdio: "ignore",
          });
          browser.on("error", () => {
            // Ignore — browser open is best-effort
          });
        }, 3000);
      }

      child.on("exit", (code) => {
        if (browserTimer) clearTimeout(browserTimer);
        process.exit(code ?? 0);
      });
    });
}
