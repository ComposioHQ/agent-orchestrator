/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@composio/core"],
  transpilePackages: [
    "@composio/ao-core",
    "@composio/ao-plugin-agent-claude-code",
    "@composio/ao-plugin-agent-opencode",
    "@composio/ao-plugin-runtime-tmux",
    "@composio/ao-plugin-scm-github",
    "@composio/ao-plugin-tracker-github",
    "@composio/ao-plugin-tracker-linear",
    "@composio/ao-plugin-workspace-worktree",
  ],
};

// Only load bundle analyzer when ANALYZE=true (dev-only dependency)
let config = nextConfig;
if (process.env.ANALYZE === "true") {
  const { default: bundleAnalyzer } = await import("@next/bundle-analyzer");
  config = bundleAnalyzer({ enabled: true })(nextConfig);
}

export default config;
