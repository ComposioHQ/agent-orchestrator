/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@composio/core"],
  transpilePackages: [
    "@aoagents/ao-core",
    "@aoagents/ao-plugin-agent-claude-code",
    "@aoagents/ao-plugin-agent-opencode",
    "@aoagents/ao-plugin-runtime-tmux",
    "@aoagents/ao-plugin-scm-github",
    "@aoagents/ao-plugin-tracker-github",
    "@aoagents/ao-plugin-tracker-linear",
    "@aoagents/ao-plugin-workspace-worktree",
  ],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // @composio/core is an optional peer dep of tracker-linear (the Composio SDK,
      // not our internal @aoagents/ao-core). It's dynamically imported with a try/catch
      // at runtime, but webpack still tries to resolve it at build time since
      // tracker-linear is in transpilePackages. Mark it as external so webpack
      // skips resolution entirely.
      config.externals = config.externals || [];
      config.externals.push("@composio/core");
    }
    return config;
  },
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
