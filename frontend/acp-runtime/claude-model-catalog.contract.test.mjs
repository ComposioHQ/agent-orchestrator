import assert from "node:assert/strict";
import test from "node:test";

import { discoverClaudeModels } from "./claude-model-catalog.mjs";

test("installed Claude SDK returns a selectable model catalog", {
	skip: process.env.AO_TEST_CLAUDE_MODEL_CATALOG !== "1",
}, async () => {
	const models = await discoverClaudeModels({
		claudeExecutable: process.env.CLAUDE_CODE_EXECUTABLE,
		cwd: process.cwd(),
		env: process.env,
	});
	assert.ok(models.length > 0);
	for (const model of models) {
		assert.equal(typeof model.value, "string");
		assert.ok(model.value.trim().length > 0);
		assert.equal(typeof model.displayName, "string");
		assert.ok(model.displayName.trim().length > 0);
	}
});
