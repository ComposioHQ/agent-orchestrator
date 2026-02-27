import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

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
    // Core's plugin-registry uses dynamic import(pkg); webpack can't resolve it at build time.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      { module: /plugin-registry\.js$/, message: /Critical dependency: the request of a dependency is an expression/ },
    ];
    return config;
  },
};

export default nextConfig;
