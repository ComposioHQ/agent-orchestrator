/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@composio/ao-core"],

  // @composio/core is an optional peer dep of tracker-linear (Composio SDK).
  // Mark it as external so webpack doesn't fail when it's not installed.
  serverExternalPackages: ["@composio/core"],

  webpack: (config, { isServer }) => {
    if (isServer) {
      // Suppress "Critical dependency: the request of a dependency is an expression"
      // from plugin-registry.ts's dynamic import(pkg). The web app uses explicit
      // static imports in services.ts instead of loadBuiltins(), so this is safe.
      config.module.exprContextCritical = false;
    }
    return config;
  },
};

export default nextConfig;
