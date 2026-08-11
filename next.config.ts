import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const config: NextConfig = {
	reactStrictMode: true,
	turbopack: {
		root: fileURLToPath(new URL("..", import.meta.url)),
	},
};

export default config;
