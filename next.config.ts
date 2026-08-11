import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
	agentRules: false,
	reactStrictMode: true,
	turbopack: {
		root: path.resolve(process.cwd(), "../.."),
	},
};

export default config;
