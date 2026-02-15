/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@composio/ao-core"],
  async rewrites() {
    const terminalPort = process.env.NEXT_PUBLIC_TERMINAL_PORT ?? "3001";
    return [
      {
        source: "/terminal-proxy/:path*",
        destination: `http://localhost:${terminalPort}/:path*`,
      },
    ];
  },
};

export default nextConfig;
