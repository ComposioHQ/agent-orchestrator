// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	BROWSER_IMPORT_DATA,
	createBrowserImportEngine,
	normalizeBookmarks,
	type BrowserImportRoot,
} from "./browser-import-engine";

function sourceBookmarks() {
	return {
		checksum: "source",
		roots: {
			bookmark_bar: {
				name: "Bookmarks bar",
				type: "folder",
				children: [
					{ name: "AO", type: "url", url: "https://ao.example.test/docs" },
					{ name: "Unsupported", type: "url", url: "javascript:alert(1)" },
					{ name: "Nested", type: "folder", children: [{ name: "Nested AO", type: "url", url: "https://ao.example.test/nested" }] },
				],
			},
			other: { name: "Other bookmarks", type: "folder", children: [] },
			synced: { name: "Mobile bookmarks", type: "folder", children: [] },
		},
		version: 1,
	};
}

async function createFixture() {
	const homeDir = await mkdtemp(path.join(os.tmpdir(), "ao-browser-import-home-"));
	const aoDataRoot = await mkdtemp(path.join(os.tmpdir(), "ao-browser-import-dest-"));
	const sourceRoot = path.join(homeDir, "Google", "Chrome");
	const profilePath = path.join(sourceRoot, "Default");
	await mkdir(profilePath, { recursive: true });
	await writeFile(path.join(profilePath, "Bookmarks"), JSON.stringify(sourceBookmarks()), "utf8");
	const roots: BrowserImportRoot[] = [{ browser: "chrome", label: "Google Chrome", path: sourceRoot }];
	const engine = createBrowserImportEngine({
		homeDir,
		platform: "win32",
		aoDataRoot,
		destinationBookmarksPath: path.join(aoDataRoot, "Partitions", "ao-browser", "Bookmarks"),
		roots,
		randomId: (() => {
			let next = 0;
			return () => `fixture-id-${next++}`;
		})(),
		now: () => new Date("2026-08-18T00:00:00.000Z"),
	});
	return { aoDataRoot, engine, homeDir };
}

describe("browser import engine", () => {
	it("normalizes bookmarks, rejects executable URLs, and computes a Chromium checksum", () => {
		const normalized = normalizeBookmarks(sourceBookmarks(), {
			randomId: () => "fixture-guid",
			now: () => new Date("2026-08-18T00:00:00.000Z"),
		});

		expect(normalized?.importedBookmarks).toBe(2);
		expect(normalized?.skippedBookmarks).toBe(1);
		expect(normalized?.file.checksum).toMatch(/^[0-9A-F]{32}$/);
		expect(normalized?.file.roots.bookmark_bar.children ?? []).toHaveLength(2);
		expect(normalized?.file.roots.bookmark_bar.children?.[0]).toMatchObject({
			type: "url",
			url: "https://ao.example.test/docs",
		});
		expect(normalized?.file.roots.bookmark_bar.children?.[1].children?.[0]).toMatchObject({
			url: "https://ao.example.test/nested",
		});
	});

	it("detects supported profiles without exposing filesystem paths", async () => {
		const { engine, homeDir, aoDataRoot } = await createFixture();
		const scan = await engine.detect();

		expect(scan.supportedData).toEqual(BROWSER_IMPORT_DATA);
		expect(scan.sources).toHaveLength(1);
		expect(scan.sources[0]).toMatchObject({
			browser: "chrome",
			label: "Google Chrome",
			profileName: "Default profile",
			bookmarkCount: 2,
		});
		expect(scan.sources[0]).not.toHaveProperty("path");
		expect(JSON.stringify(scan.sources[0])).not.toContain(homeDir);
		await rm(homeDir, { recursive: true, force: true });
		await rm(aoDataRoot, { recursive: true, force: true });
	});

	it("imports only the transformed bookmark file into the AO destination", async () => {
		const { engine, aoDataRoot, homeDir } = await createFixture();
		const scan = await engine.detect();
		const result = await engine.importSource(scan.sources[0].id);
		const destination = path.join(aoDataRoot, "Partitions", "ao-browser", "Bookmarks");
		const persisted = JSON.parse(await readFile(destination, "utf8")) as { roots: { bookmark_bar: { children: unknown[] } } };

		expect(result).toEqual({
			sourceBrowser: "chrome",
			sourceProfile: "Default profile",
			importedBookmarks: 2,
			skippedBookmarks: 1,
			destination: "ao-persistent-browser",
		});
		expect(persisted.roots.bookmark_bar.children).toHaveLength(2);
		expect(await readFile(destination, "utf8")).not.toContain(homeDir);
		await rm(homeDir, { recursive: true, force: true });
		await rm(aoDataRoot, { recursive: true, force: true });
	});

	it("does not overwrite an existing AO destination", async () => {
		const { engine, aoDataRoot, homeDir } = await createFixture();
		const scan = await engine.detect();
		const destination = path.join(aoDataRoot, "Partitions", "ao-browser", "Bookmarks");
		await mkdir(path.dirname(destination), { recursive: true });
		await writeFile(destination, "existing", "utf8");

		await expect(engine.importSource(scan.sources[0].id)).rejects.toMatchObject({
			code: "DESTINATION_NOT_EMPTY",
		});
		expect(await readFile(destination, "utf8")).toBe("existing");
		await rm(homeDir, { recursive: true, force: true });
		await rm(aoDataRoot, { recursive: true, force: true });
	});

	it("rejects imports after the persistent destination has been activated", async () => {
		const { aoDataRoot, homeDir } = await createFixture();
		const activeEngine = createBrowserImportEngine({
			homeDir,
			platform: "win32",
			aoDataRoot,
			destinationBookmarksPath: path.join(aoDataRoot, "Bookmarks"),
			roots: [{ browser: "chrome", label: "Google Chrome", path: path.join(homeDir, "Google", "Chrome") }],
			isDestinationActive: () => true,
		});
		const activeScan = await activeEngine.detect();

		await expect(activeEngine.importSource(activeScan.sources[0].id)).rejects.toMatchObject({
			code: "DESTINATION_ACTIVE",
		});
		await rm(homeDir, { recursive: true, force: true });
		await rm(aoDataRoot, { recursive: true, force: true });
	});
});
