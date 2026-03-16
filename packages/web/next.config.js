/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@composio/ao-core"],

  webpack: (config, { isServer }) => {
    if (isServer) {
      // Suppress "Critical dependency: the request of a dependency is an expression"
      // from plugin-registry.ts's dynamic import(pkg). The web app uses explicit
      // static imports in services.ts instead of loadBuiltins(), so this is safe.
      config.module.exprContextCritical = false;

      // @composio/core is an optional peer dep of tracker-linear (Composio SDK).
      // tracker-linear handles the missing module at runtime with a try/catch,
      // but webpack still tries to resolve it at build time. Marking it as an
      // external prevents the "Module not found" error.
      config.externals = config.externals || [];
      config.externals.push("@composio/core");
    }
    return config;
  },
};

export default nextConfig;
