import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
	agentRules: false,
	devIndicators: false,
	reactStrictMode: true,
	output: "standalone",
	turbopack: {
		root: path.resolve(process.cwd(), "../.."),
	},
};

export default config;
