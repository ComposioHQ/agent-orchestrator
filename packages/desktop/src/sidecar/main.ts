import { createDesktopSidecarServer } from "./server.js";

async function main(): Promise<void> {
  const port = Number(process.env.AO_DESKTOP_SIDECAR_PORT ?? "17071");
  const host = process.env.AO_DESKTOP_SIDECAR_HOST ?? "127.0.0.1";

  const server = createDesktopSidecarServer({
    host,
    port,
    shellSelection: {
      preferred: (process.env.AO_DESKTOP_DEFAULT_SHELL as
        | "windows-powershell"
        | "cmd"
        | "git-bash"
        | "wsl"
        | undefined),
      wslDistribution: process.env.AO_DESKTOP_WSL_DISTRO,
      gitBashPath: process.env.AO_DESKTOP_GIT_BASH_PATH,
    },
  });

  await server.start();
  console.log(`[desktop-sidecar] listening on http://${host}:${port}`);

  const shutdown = async (signal: string) => {
    console.log(`[desktop-sidecar] received ${signal}, shutting down`);
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
