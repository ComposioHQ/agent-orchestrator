/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    "@composio/ao-core",
    "@composio/ao-plugin-runtime-tmux",
    "@composio/ao-plugin-agent-claude-code",
    "@composio/ao-plugin-agent-codex",
    "@composio/ao-plugin-workspace-worktree",
    "@composio/ao-plugin-scm-github",
    "@composio/ao-plugin-tracker-github",
    "@composio/ao-plugin-tracker-linear",
  ],
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
