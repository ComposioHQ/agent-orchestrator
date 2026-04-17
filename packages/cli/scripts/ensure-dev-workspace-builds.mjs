import { spawnSync } from "node:child_process";

const packages = [
  "@aoagents/ao-core",
  "@aoagents/ao-plugin-agent-aider",
  "@aoagents/ao-plugin-agent-claude-code",
  "@aoagents/ao-plugin-agent-codex",
  "@aoagents/ao-plugin-agent-cursor",
  "@aoagents/ao-plugin-agent-opencode",
  "@aoagents/ao-plugin-scm-github",
];

for (const pkg of packages) {
  const result = spawnSync("pnpm", ["--filter", pkg, "build"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
