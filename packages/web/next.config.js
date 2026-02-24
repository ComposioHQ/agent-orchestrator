const path = require("path");

// Resolve @composio/core only when not installed, so COMPOSIO_API_KEY + real SDK work.
let stubComposioCorePath = null;
try {
  require.resolve("@composio/core");
} catch {
  stubComposioCorePath = path.resolve(__dirname, "stub-composio-core.js");
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@composio/ao-core"],
  webpack: (config) => {
    if (stubComposioCorePath) {
      config.resolve.alias = {
        ...config.resolve.alias,
        "@composio/core": stubComposioCorePath,
      };
    }
    return config;
  },
};

export default nextConfig;
