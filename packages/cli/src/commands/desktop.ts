import { Command } from "commander";
import { createDesktopSidecarServer } from "@composio/ao-desktop";

export function registerDesktop(program: Command): void {
  const desktop = program.command("desktop").description("Desktop tooling commands");

  desktop
    .command("sidecar")
    .description("Run desktop sidecar API server")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", "17071")
    .option("--default-shell <profile>", "Default shell profile")
    .option("--wsl-distro <name>", "Preferred WSL distro")
    .option("--git-bash <path>", "Explicit git-bash executable path")
    .action(async (opts) => {
      const server = createDesktopSidecarServer({
        host: opts.host as string,
        port: Number(opts.port),
        shellSelection: {
          preferred: opts.defaultShell as
            | "windows-powershell"
            | "cmd"
            | "git-bash"
            | "wsl"
            | undefined,
          wslDistribution: opts.wslDistro as string | undefined,
          gitBashPath: opts.gitBash as string | undefined,
        },
      });

      await server.start();
      process.stdout.write(
        `[ao desktop] sidecar listening on http://${opts.host}:${opts.port}\n`,
      );
    });

  desktop
    .command("shells")
    .description("Show detected shell capabilities for desktop mode")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", "17071")
    .action(async (opts) => {
      const res = await fetch(`http://${opts.host}:${opts.port}/shells`);
      if (!res.ok) {
        throw new Error(`Failed to fetch shell capabilities (${res.status})`);
      }
      const data = (await res.json()) as {
        capabilities: Array<{
          profile: { id: string };
          available: boolean;
          resolvedPath: string | null;
          reason?: string;
        }>;
      };
      for (const capability of data.capabilities) {
        const status = capability.available
          ? `available (${capability.resolvedPath ?? "unknown path"})`
          : `missing (${capability.reason ?? "unknown"})`;
        process.stdout.write(`${capability.profile.id}: ${status}\n`);
      }
    });
}
