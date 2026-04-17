import { spawnSync } from "node:child_process";

const rawArgs = process.argv.slice(2);
const cliArgs = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

const bootstrap = spawnSync("node", ["./scripts/ensure-dev-workspace-builds.mjs"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (bootstrap.status !== 0) {
  process.exit(bootstrap.status ?? 1);
}

const cli = spawnSync("tsx", ["src/index.ts", ...cliArgs], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(cli.status ?? 1);
