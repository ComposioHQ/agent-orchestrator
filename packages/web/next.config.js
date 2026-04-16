import { createMDX } from "fumadocs-mdx/next";

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

const withMDX = createMDX();

// Only load bundle analyzer when ANALYZE=true (dev-only dependency)
let config = withMDX(nextConfig);
if (process.env.ANALYZE === "true") {
  const { default: bundleAnalyzer } = await import("@next/bundle-analyzer");
  config = bundleAnalyzer({ enabled: true })(config);
}

export default config;
