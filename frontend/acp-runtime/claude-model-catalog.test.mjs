import assert from "node:assert/strict";
import test from "node:test";

import { discoverClaudeModels } from "./claude-model-catalog.mjs";

test("discovers models through an isolated non-persistent SDK query", async () => {
	let captured;
	let closed = 0;
	const expected = [
		{ value: "sonnet", displayName: "Sonnet", description: "Balanced" },
		{ value: "opus", displayName: "Opus", description: "Most capable" },
	];
	const queryImpl = (params) => {
		captured = params;
		return {
			supportedModels: async () => expected,
			close: () => { closed += 1; },
		};
	};

	const models = await discoverClaudeModels({
		queryImpl,
		claudeExecutable: "/opt/claude/bin/claude",
		cwd: "/work/project",
		env: { PATH: "/usr/bin" },
	});

	assert.deepEqual(models, expected);
	assert.equal(closed, 1);
	assert.equal(typeof captured.prompt[Symbol.asyncIterator], "function");
	assert.deepEqual(captured.options, {
		pathToClaudeCodeExecutable: "/opt/claude/bin/claude",
		cwd: "/work/project",
		env: { PATH: "/usr/bin" },
		persistSession: false,
		settingSources: [],
		settings: { disableAllHooks: true },
		tools: [],
		mcpServers: {},
		strictMcpConfig: true,
	});
});

test("closes the SDK query when model discovery fails", async () => {
	let closed = 0;
	const queryImpl = () => ({
		supportedModels: async () => { throw new Error("account unavailable"); },
		close: () => { closed += 1; },
	});

	await assert.rejects(
		discoverClaudeModels({
			queryImpl,
			claudeExecutable: "/opt/claude/bin/claude",
			cwd: "/work/project",
			env: {},
		}),
		/account unavailable/,
	);
	assert.equal(closed, 1);
});

test("rejects a missing Claude executable before starting the SDK", async () => {
	let called = false;
	await assert.rejects(
		discoverClaudeModels({
			queryImpl: () => { called = true; },
			claudeExecutable: "  ",
			cwd: "/work/project",
			env: {},
		}),
		/CLAUDE_CODE_EXECUTABLE is required/,
	);
	assert.equal(called, false);
});
