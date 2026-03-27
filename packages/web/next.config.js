/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@composio/ao-core",
    "@composio/ao-plugin-agent-acpx",
    "@composio/ao-plugin-agent-claude-code",
    "@composio/ao-plugin-agent-opencode",
    "@composio/ao-plugin-runtime-tmux",
    "@composio/ao-plugin-scm-github",
    "@composio/ao-plugin-tracker-github",
    "@composio/ao-plugin-tracker-linear",
    "@composio/ao-plugin-workspace-worktree",
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

export default nextConfig;
