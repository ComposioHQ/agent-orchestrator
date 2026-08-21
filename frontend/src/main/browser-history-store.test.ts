import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserHistoryStore, type BrowserHistoryEntry } from "./browser-history-store";

const profileId = "11111111-1111-4111-8111-111111111111";
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryState(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "ao-browser-history-"));
	temporaryDirectories.push(directory);
	return directory;
}

describe("BrowserHistoryStore", () => {
	it("merges, persists, reloads, suggests, and clears profile-scoped history", async () => {
		const stateDir = await temporaryState();
		const store = new BrowserHistoryStore({ stateDir });
		await expect(store.mergeImportedEntries(profileId, [
			{ url: "https://github.com/openai", title: "OpenAI", lastVisited: "2026-01-01T00:00:00.000Z", visitCount: 2 },
			{ url: "file:///secret", title: "Secret", lastVisited: "2026-01-02T00:00:00.000Z", visitCount: 1 },
		])).resolves.toBe(1);

		expect(await store.suggest(profileId, "openai")).toEqual([
			{ url: "https://github.com/openai", title: "OpenAI" },
		]);
		const reloaded = new BrowserHistoryStore({ stateDir });
		expect(await reloaded.suggest(profileId, "github")).toHaveLength(1);
		await reloaded.clear(profileId);
		expect(await new BrowserHistoryStore({ stateDir }).suggest(profileId, "github")).toEqual([]);
	});

	it("caps entry count and serialized output without retaining an oversized cache", async () => {
		const stateDir = await temporaryState();
		const store = new BrowserHistoryStore({ stateDir });
		const entries: BrowserHistoryEntry[] = Array.from({ length: 5_100 }, (_, index) => ({
			url: `https://example.com/${index}/${"x".repeat(900)}`,
			title: `Entry ${index}`,
			lastVisited: new Date(1_800_000_000_000 - index).toISOString(),
			visitCount: 1,
		}));
		const retained = await store.mergeImportedEntries(profileId, entries);
		const file = path.join(stateDir, "browser-history", `${profileId}.json`);
		const metadata = await stat(file);
		const parsed = JSON.parse(await readFile(file, "utf8")) as { entries: BrowserHistoryEntry[] };
		expect(metadata.size).toBeLessThanOrEqual(4 * 1024 * 1024);
		expect(parsed.entries.length).toBe(retained);
		expect(parsed.entries.length).toBeLessThanOrEqual(5_000);
		expect(await store.suggest(profileId, "entry 5099")).toEqual([]);
	});
});
