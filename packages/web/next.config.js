/** @type {import('next').NextConfig} */
const rawBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const normalizedBasePath = rawBasePath
  ? `/${rawBasePath.replace(/^\/+|\/+$/g, "")}`
  : "";

const nextConfig = {
  transpilePackages: ["@composio/ao-core"],
  basePath: normalizedBasePath,
};

export default nextConfig;
