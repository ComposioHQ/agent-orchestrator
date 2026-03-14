import { normalizeBasePath } from "./src/lib/base-path.js";

const normalizedBasePath = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH ?? "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@composio/ao-core"],
  basePath: normalizedBasePath || undefined,
};

export default nextConfig;
