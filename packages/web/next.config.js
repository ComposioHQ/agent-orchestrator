/** @type {import('next').NextConfig} */
const nextConfig = {
  // @composio/core: optional transitive dep via tracker-linear (dynamic import); kept external
  // so it is resolved from node_modules at runtime instead of being bundled.
  serverExternalPackages: ["@composio/core"],
  transpilePackages: [
    // @aoagents/ao-core: must stay here — dist/ is gitignored so a fresh checkout has no
    // dist/index.js; transpilePackages lets webpack compile from source directly.
    // Client components (SessionDetail, ProjectSidebar, sessions/[id]/page) also import
    // @aoagents/ao-core/types which serverExternalPackages does not cover.
    "@aoagents/ao-core",
    "@aoagents/ao-plugin-agent-claude-code",
    "@aoagents/ao-plugin-agent-opencode",
    "@aoagents/ao-plugin-runtime-tmux",
    "@aoagents/ao-plugin-scm-github",
    "@aoagents/ao-plugin-tracker-github",
    "@aoagents/ao-plugin-tracker-linear",
    "@aoagents/ao-plugin-workspace-worktree",
  ],
  webpack(config) {
    config.module.rules.push({
      test: /plugin-registry\.js$/,
      parser: { exprContextCritical: false },
    });
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
