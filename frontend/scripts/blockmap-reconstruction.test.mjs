// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { writeBlockmap } from "./blockmap.mjs";

const require = createRequire(import.meta.url);
const { GenericDifferentialDownloader } = require(
	"electron-updater/out/differentialDownloader/GenericDifferentialDownloader.js",
);
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const temporaryDirectories = [];

afterEach(() => {
	for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureBytes(seed, size = 512_000) {
	const value = Buffer.allocUnsafe(size);
	for (let offset = 0, counter = 0; offset < size; counter += 1) {
		const chunk = createHash("sha512").update(`${seed}:${counter}`).digest();
		chunk.copy(value, offset);
		offset += chunk.length;
	}
	return value;
}

async function artifacts(arch) {
	const dir = mkdtempSync(join(tmpdir(), `ao-blockmap-${arch}-`));
	temporaryDirectories.push(dir);
	const oldFile = join(dir, `old-darwin-${arch}.zip`);
	const newFile = join(dir, `new-darwin-${arch}.zip`);
	const oldBytes = fixtureBytes(`${arch}:old`);
	const newBytes = Buffer.from(oldBytes);
	fixtureBytes(`${arch}:patch`, 48_000).copy(newBytes, 180_000);
	writeFileSync(oldFile, oldBytes);
	writeFileSync(newFile, newBytes);
	const oldInfo = await writeBlockmap(oldFile);
	const newInfo = await writeBlockmap(newFile);
	return {
		dir,
		oldFile,
		newFile,
		oldMap: JSON.parse(gunzipSync(readFileSync(`${oldFile}.blockmap`)).toString()),
		newMap: JSON.parse(gunzipSync(readFileSync(`${newFile}.blockmap`)).toString()),
		oldInfo,
		newInfo,
		newBytes,
	};
}

async function withServer(file, rejectRanges, run) {
	let fullRequests = 0;
	const bytes = readFileSync(file);
	const server = createServer((request, response) => {
		const range = request.headers.range;
		if (range && !rejectRanges) {
			const match = /^bytes=(\d+)-(\d+)$/.exec(range);
			if (!match) {
				response.writeHead(416).end();
				return;
			}
			const start = Number(match[1]);
			const end = Number(match[2]);
			response.writeHead(206, {
				"Accept-Ranges": "bytes",
				"Content-Length": end - start + 1,
				"Content-Range": `bytes ${start}-${end}/${bytes.length}`,
			});
			response.end(bytes.subarray(start, end + 1));
			return;
		}
		if (!range) fullRequests += 1;
		response.writeHead(200, { "Content-Length": bytes.length });
		response.end(bytes);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (typeof address === "string" || address === null) throw new Error("missing server address");
		return await run(new URL(`http://127.0.0.1:${address.port}/target.zip`), () => fullRequests);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

function httpExecutor() {
	return {
		createRequest(options, callback) {
			return httpRequest(options, callback);
		},
		addErrorAndTimeoutHandlers(request, reject) {
			request.on("error", reject);
			request.setTimeout(5_000, () => request.destroy(new Error("request timeout")));
		},
	};
}

async function reconstructWithSingleFallback(fixture, failure) {
	return withServer(fixture.newFile, failure === "range-rejected", async (url, fullRequestCount) => {
		const destination = join(fixture.dir, `${failure}.zip`);
		let fallbackCount = 0;
		try {
			if (failure === "missing-old-blockmap") throw new Error("old blockmap unavailable");
			if (failure === "unavailable-sidecar") throw new Error("new blockmap unavailable");
			const newMap = structuredClone(fixture.newMap);
			if (failure === "corrupt-blockmap") newMap.version = "invalid";
			const sha512 =
				failure === "digest-mismatch"
					? createHash("sha512").update("wrong target").digest("base64")
					: fixture.newInfo.sha512;
			const downloader = new GenericDifferentialDownloader(
				{ size: fixture.newInfo.size, sha512 },
				httpExecutor(),
				{
					newUrl: url,
					oldFile: fixture.oldFile,
					newFile: destination,
					logger,
					isUseMultipleRangeRequest: false,
					requestHeaders: {},
				},
			);
			await downloader.download(fixture.oldMap, newMap);
		} catch {
			fallbackCount += 1;
			const response = await fetch(url);
			if (!response.ok) throw new Error(`fallback HTTP ${response.status}`);
			writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
		}
		return {
			actual: readFileSync(destination),
			fallbackCount,
			fullRequestCount: fullRequestCount(),
		};
	});
}

describe("electron-updater macOS blockmap reconstruction contract", () => {
	it.each(["arm64", "x64"])("reconstructs a byte-identical %s target", async (arch) => {
		const fixture = await artifacts(arch);
		const result = await reconstructWithSingleFallback(fixture, "none");

		expect(result.actual.equals(fixture.newBytes)).toBe(true);
		expect(result.fallbackCount).toBe(0);
		expect(result.fullRequestCount).toBe(0);
	});

	it.each([
		"missing-old-blockmap",
		"range-rejected",
		"corrupt-blockmap",
		"digest-mismatch",
		"unavailable-sidecar",
	])("falls back exactly once to a clean full ZIP for %s", async (failure) => {
		const fixture = await artifacts("arm64");
		const result = await reconstructWithSingleFallback(fixture, failure);

		expect(result.actual.equals(fixture.newBytes)).toBe(true);
		expect(result.fallbackCount).toBe(1);
		expect(result.fullRequestCount).toBe(1);
	});
});
