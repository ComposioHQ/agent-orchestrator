/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@composio/ao-core"],
  webpack: (config, { isServer }) => {
    // tracker-linear optionally uses @composio/core; stub so Next.js can resolve it
    config.resolve.alias = {
      ...config.resolve.alias,
      "@composio/core": require("path").resolve(__dirname, "stub-composio-core.js"),
    };
    return config;
  },
};

export default nextConfig;
