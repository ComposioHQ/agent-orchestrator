"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const builds = {
	"2026.08.11-e8db854": {
		aboutChunk: "5105.index.js",
		usageChunk: 6260,
		patch(source) {
			const importNeedle = ',u=l("./src/utils/terminal-environment.ts"),d=function';
			const importReplacement = ',u=l("./src/utils/terminal-environment.ts"),usageModule=l.e(6260).then(()=>l("./src/usage/usage-data.ts")),d=function';
			const returnNeedle = "return{cliVersion:f,model:b,subscriptionTier:A,osPlatform:p,osArch:h,userEmail:y,terminalProgram:q,shell:I,lastRequestId:R}";
			const returnReplacement = 'const usage=yield usageModule,usageResult=yield usage.d({client:l,locale:"en-US"});return{cliVersion:f,usage:usageResult}';
			return replaceExactly(source, importNeedle, importReplacement, returnNeedle, returnReplacement);
		},
	},
	"2026.08.25-3e8eec8": {
		aboutChunk: "4374.index.js",
		usageChunk: 89,
		patch(source) {
			const importNeedle = ',c=n("./src/utils/terminal-environment.ts"),u=n("./src/commands/update-core.ts"),d=function';
			const importReplacement = ',c=n("./src/utils/terminal-environment.ts"),u=n("./src/commands/update-core.ts"),usageModule=n.e(89).then(()=>n("./src/usage/usage-data.ts")),d=function';
			const promiseNeedle = "[S,I]=yield Promise.all([(0,u.resolveLatestVersionStatus)(n,{channel:m.channel,product:r}),p(e,n)]);";
			const promiseReplacement = "[S,I,usageModuleValue]=yield Promise.all([(0,u.resolveLatestVersionStatus)(n,{channel:m.channel,product:r}),p(e,n),usageModule]);";
			const resultPattern = /return Object\.assign\(Object\.assign\(\{cliVersion:f\},function\(e\)\{.*?\}\(S\)\),\{model:h,subscriptionTier:I\.subscriptionTier,osPlatform:v,osArch:g,userEmail:I\.userEmail,terminalProgram:y,shell:b,lastRequestId:w\}\)/;
			if (!source.includes(importNeedle) || !source.includes(promiseNeedle) || !resultPattern.test(source)) {
				throw new Error("unsupported Cursor about module shape");
			}
			return source
				.replace(importNeedle, importReplacement)
				.replace(promiseNeedle, promiseReplacement)
				.replace(resultPattern, 'return{cliVersion:f,usage:yield usageModuleValue.d({client:n,locale:"en-US"})}');
		},
	},
};

function replaceExactly(source, firstNeedle, firstReplacement, secondNeedle, secondReplacement) {
	if (!source.includes(firstNeedle) || !source.includes(secondNeedle)) {
		throw new Error("unsupported Cursor about module shape");
	}
	return source.replace(firstNeedle, firstReplacement).replace(secondNeedle, secondReplacement);
}

function patchAboutSource(source, build) {
	const spec = builds[build];
	if (!spec) throw new Error("unsupported Cursor build");
	return spec.patch(source);
}

function run(cursorDir, build) {
	const spec = builds[build];
	if (!cursorDir || !spec) throw new Error("supported Cursor runtime and build are required");
	const entry = path.join(cursorDir, "index.js");
	const aboutChunk = path.join(cursorDir, spec.aboutChunk);
	const originalLoader = Module._extensions[".js"];
	Module._extensions[".js"] = function cursorUsageLoader(module, filename) {
		if (filename === aboutChunk) {
			module._compile(patchAboutSource(fs.readFileSync(filename, "utf8"), build), filename);
			return;
		}
		originalLoader(module, filename);
	};
	process.argv = [process.execPath, entry, "about", "--format", "json"];
	require(entry);
}

module.exports = { builds, patchAboutSource };

if (require.main === module) run(process.argv[2], process.argv[3]);
