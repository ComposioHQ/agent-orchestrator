import { pathToFileURL } from "node:url";

import { query } from "@anthropic-ai/claude-agent-sdk";

function heldOpenPrompt() {
	let release;
	const prompt = (async function* () {
		await new Promise((resolve) => { release = resolve; });
	})();
	return { prompt, release: () => release?.() };
}

export async function discoverClaudeModels({ queryImpl = query, claudeExecutable, cwd, env }) {
	if (typeof claudeExecutable !== "string" || claudeExecutable.trim() === "") {
		throw new Error("CLAUDE_CODE_EXECUTABLE is required");
	}
	const input = heldOpenPrompt();
	const sdkQuery = queryImpl({
		prompt: input.prompt,
		options: {
			pathToClaudeCodeExecutable: claudeExecutable,
			cwd,
			env,
			persistSession: false,
			settingSources: [],
			settings: { disableAllHooks: true },
			tools: [],
			mcpServers: {},
			strictMcpConfig: true,
		},
	});
	try {
		return await sdkQuery.supportedModels();
	} finally {
		input.release();
		sdkQuery.close();
	}
}

async function main() {
	const models = await discoverClaudeModels({
		claudeExecutable: process.env.CLAUDE_CODE_EXECUTABLE,
		cwd: process.cwd(),
		env: process.env,
	});
	process.stdout.write(`${JSON.stringify({ version: 1, models })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`Claude model discovery failed: ${message}\n`);
		process.exitCode = 1;
	});
}
