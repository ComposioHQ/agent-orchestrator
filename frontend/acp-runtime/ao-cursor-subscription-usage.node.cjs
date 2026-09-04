"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { patchAboutSource } = require("./ao-cursor-subscription-usage.cjs");

test("patches the original supported build without retaining account identity", () => {
	const source = 'x,u=l("./src/utils/terminal-environment.ts"),d=function y return{cliVersion:f,model:b,subscriptionTier:A,osPlatform:p,osArch:h,userEmail:y,terminalProgram:q,shell:I,lastRequestId:R} z';
	const patched = patchAboutSource(source, "2026.08.11-e8db854");
	assert.match(patched, /usageModule=l\.e\(6260\)/);
	assert.match(patched, /return\{cliVersion:f,usage:usageResult\}/);
	assert.doesNotMatch(patched, /userEmail/);
});

test("patches the current supported build without retaining account identity", () => {
	const source = 'x,c=n("./src/utils/terminal-environment.ts"),u=n("./src/commands/update-core.ts"),d=function y [S,I]=yield Promise.all([(0,u.resolveLatestVersionStatus)(n,{channel:m.channel,product:r}),p(e,n)]);return Object.assign(Object.assign({cliVersion:f},function(e){switch(e.status){case"up_to_date":return{latestStatus:e.status}}}(S)),{model:h,subscriptionTier:I.subscriptionTier,osPlatform:v,osArch:g,userEmail:I.userEmail,terminalProgram:y,shell:b,lastRequestId:w}) z';
	const patched = patchAboutSource(source, "2026.08.25-3e8eec8");
	assert.match(patched, /usageModule=n\.e\(89\)/);
	assert.match(patched, /return\{cliVersion:f,usage:yield usageModuleValue\.d/);
	assert.doesNotMatch(patched, /userEmail/);
});

test("rejects unknown builds and bundle shapes", () => {
	assert.throws(() => patchAboutSource("different build", "2026.08.25-3e8eec8"), /unsupported Cursor/);
	assert.throws(() => patchAboutSource("different build", "2099.01.01-unknown"), /unsupported Cursor/);
});
