/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@composio/core", "composio-core"],
  transpilePackages: [
    "@aoagents/ao-core",
    "@aoagents/ao-plugin-agent-aider",
    "@aoagents/ao-plugin-agent-claude-code",
    "@aoagents/ao-plugin-agent-codex",
    "@aoagents/ao-plugin-agent-cursor",
    "@aoagents/ao-plugin-agent-opencode",
    "@aoagents/ao-plugin-notifier-composio",
    "@aoagents/ao-plugin-notifier-desktop",
    "@aoagents/ao-plugin-notifier-discord",
    "@aoagents/ao-plugin-notifier-openclaw",
    "@aoagents/ao-plugin-notifier-slack",
    "@aoagents/ao-plugin-notifier-webhook",
    "@aoagents/ao-plugin-runtime-process",
    "@aoagents/ao-plugin-runtime-tmux",
    "@aoagents/ao-plugin-scm-github",
    "@aoagents/ao-plugin-scm-gitlab",
    "@aoagents/ao-plugin-terminal-iterm2",
    "@aoagents/ao-plugin-terminal-web",
    "@aoagents/ao-plugin-tracker-github",
    "@aoagents/ao-plugin-tracker-gitlab",
    "@aoagents/ao-plugin-tracker-linear",
    "@aoagents/ao-plugin-workspace-clone",
    "@aoagents/ao-plugin-workspace-worktree",
  ],
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

// Only load bundle analyzer when ANALYZE=true (dev-only dependency)
let config = nextConfig;
if (process.env.ANALYZE === "true") {
  const { default: bundleAnalyzer } = await import("@next/bundle-analyzer");
  config = bundleAnalyzer({ enabled: true })(nextConfig);
}

export default config;
