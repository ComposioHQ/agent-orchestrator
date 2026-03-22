/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@composio/core"],
  transpilePackages: [
    "@composio/ao-core",
    "@composio/ao-plugin-agent-claude-code",
    "@composio/ao-plugin-agent-local-llm",
    "@composio/ao-plugin-agent-opencode",
    "@composio/ao-plugin-runtime-tmux",
    "@composio/ao-plugin-scm-github",
    "@composio/ao-plugin-tracker-github",
    "@composio/ao-plugin-tracker-linear",
    "@composio/ao-plugin-workspace-worktree",
  ],
};

export default nextConfig;
