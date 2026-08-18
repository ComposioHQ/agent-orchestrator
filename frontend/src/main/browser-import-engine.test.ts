// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	BROWSER_IMPORT_DATA,
	MAX_BOOKMARK_DEPTH,
	MAX_BOOKMARK_FILE_BYTES,
	MAX_BOOKMARK_OUTPUT_BYTES,
	MAX_IMPORTED_BOOKMARKS,
	MAX_IMPORTED_NODES,
	BrowserImportError,
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
					{
						name: "Nested",
						type: "folder",
						children: [{ name: "Nested AO", type: "url", url: "https://ao.example.test/nested" }],
					},
				],
			},
			other: { name: "Other bookmarks", type: "folder", children: [] },
			synced: { name: "Mobile bookmarks", type: "folder", children: [] },
		},
		version: 1,
	};
}

async function createFixture(value: unknown = sourceBookmarks()) {
	const homeDir = await mkdtemp(path.join(os.tmpdir(), "ao-browser-import-home-"));
	const sourceRoot = path.join(homeDir, "Google", "Chrome");
	const profilePath = path.join(sourceRoot, "Default");
	await mkdir(profilePath, { recursive: true });
	await writeFile(path.join(profilePath, "Bookmarks"), JSON.stringify(value), "utf8");
	const roots: BrowserImportRoot[] = [{ browser: "chrome", label: "Google Chrome", path: sourceRoot }];
	const engine = createBrowserImportEngine({
		homeDir,
		platform: "win32",
		roots,
		randomId: (() => {
			let next = 0;
			return () => `fixture-id-${next++}`;
		})(),
	});
	return { engine, homeDir, bookmarksPath: path.join(profilePath, "Bookmarks"), sourceRoot };
}

describe("browser import engine", () => {
	it("normalizes bookmarks into an AO tree, rejects executable URLs, and keeps AO IDs intact", () => {
		const normalized = normalizeBookmarks(sourceBookmarks(), { randomId: () => "fixture-guid" });

		expect(normalized?.importedBookmarks).toBe(2);
		expect(normalized?.skippedBookmarks).toBe(1);
		expect(normalized?.file.version).toBe(1);
		expect(normalized?.file).not.toHaveProperty("checksum");
		expect(normalized?.file.roots.bookmark_bar.children ?? []).toHaveLength(2);
		expect(normalized?.file.roots.bookmark_bar.children[0]).toMatchObject({
			type: "url",
			id: "fixture-guid-2",
			url: "https://ao.example.test/docs",
		});
	const nested = normalized?.file.roots.bookmark_bar.children[1];
		expect(nested?.type).toBe("folder");
	if (nested?.type === "folder") expect(nested.children[0]).toMatchObject({ url: "https://ao.example.test/nested" });
	});

	it("detects supported profiles without exposing filesystem paths", async () => {
		const { engine, homeDir } = await createFixture();
		try {
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
		} finally {
			await rm(homeDir, { recursive: true, force: true });
		}
	});

	it("returns normalized AO data without writing an Electron/Chromium destination", async () => {
		const { engine, homeDir } = await createFixture();
		try {
			const scan = await engine.detect();
			const result = await engine.importSource(scan.sources[0].id);

			expect(result).toMatchObject({
				sourceBrowser: "chrome",
				sourceProfile: "Default profile",
				importedBookmarks: 2,
				skippedBookmarks: 1,
				destination: "ao-persistent-browser",
			});
			expect(result.bookmarks.bookmark_bar.children).toHaveLength(2);
			expect(JSON.stringify(result)).not.toContain(homeDir);
		} finally {
			await rm(homeDir, { recursive: true, force: true });
		}
	});

	it("preflights the source file size before accepting a profile", async () => {
		const { engine, homeDir, bookmarksPath } = await createFixture("{}");
		try {
			await writeFile(bookmarksPath, Buffer.alloc(MAX_BOOKMARK_FILE_BYTES + 1));
			expect((await engine.detect()).sources).toHaveLength(0);
		} finally {
			await rm(homeDir, { recursive: true, force: true });
		}
	});

	it("enforces total-node, URL-count, depth, and serialized-output caps", () => {
		const url = (index: number) => ({ type: "url", name: `Bookmark ${index}`, url: `https://example.test/${index}` });
		const overNodes = Array.from({ length: MAX_IMPORTED_NODES }, (_, index) => url(index));
		expect(normalizeBookmarks({ roots: { bookmark_bar: { type: "folder", name: "bar", children: overNodes }, other: { type: "folder", children: [] } } })).toBeNull();

		const overURLs = Array.from({ length: MAX_IMPORTED_BOOKMARKS + 1 }, (_, index) => url(index));
		expect(normalizeBookmarks({ roots: { bookmark_bar: { type: "folder", name: "bar", children: overURLs }, other: { type: "folder", children: [] } } })).toBeNull();

		let deep: Record<string, unknown> = { type: "url", name: "deep", url: "https://example.test/deep" };
		for (let depth = 0; depth <= MAX_BOOKMARK_DEPTH; depth++) deep = { type: "folder", name: `folder-${depth}`, children: [deep] };
		expect(normalizeBookmarks({ roots: { bookmark_bar: deep, other: { type: "folder", children: [] } } })).toBeNull();

		const longName = "x".repeat(1_024);
		const largeOutput = Array.from({ length: MAX_IMPORTED_BOOKMARKS }, (_, index) => ({ ...url(index), name: longName }));
		expect(Buffer.byteLength(JSON.stringify(largeOutput), "utf8")).toBeGreaterThan(MAX_BOOKMARK_OUTPUT_BYTES);
		expect(normalizeBookmarks({ roots: { bookmark_bar: { type: "folder", name: "bar", children: largeOutput }, other: { type: "folder", children: [] } } })).toBeNull();
	});

	it("rejects source paths outside home and source symlinks", async () => {
		const { homeDir, sourceRoot } = await createFixture();
		const outside = await mkdtemp(path.join(os.tmpdir(), "ao-browser-import-outside-"));
		try {
			const outsideEngine = createBrowserImportEngine({
				homeDir,
				platform: "win32",
				roots: [{ browser: "chrome", label: "Chrome", path: outside }],
			});
			expect((await outsideEngine.detect()).sources).toHaveLength(0);

			const link = path.join(homeDir, "linked-profile");
			try {
				await symlink(sourceRoot, link, "junction");
			} catch {
				return;
			}
			const symlinkEngine = createBrowserImportEngine({
				homeDir,
				platform: "win32",
				roots: [{ browser: "chrome", label: "Chrome", path: link }],
			});
			expect((await symlinkEngine.detect()).sources).toHaveLength(0);
		} finally {
			await rm(homeDir, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("rejects imports while a persistent worker is live", async () => {
		const { homeDir } = await createFixture();
		try {
			const activeEngine = createBrowserImportEngine({
				homeDir,
				platform: "win32",
				roots: [{ browser: "chrome", label: "Google Chrome", path: path.join(homeDir, "Google", "Chrome") }],
				isDestinationActive: () => true,
			});
			const activeScan = await activeEngine.detect();
			await expect(activeEngine.importSource(activeScan.sources[0].id)).rejects.toMatchObject({ code: "DESTINATION_ACTIVE" } satisfies Partial<BrowserImportError>);
		} finally {
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});
