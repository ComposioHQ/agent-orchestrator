// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	AO_BROWSER_BOOKMARKS_FILE_NAME,
	createBrowserBookmarkStorage,
	type BrowserBookmarkDocument,
} from "./browser-bookmark-store";

function documentFor(fingerprint: string, url = "https://ao.example.test/docs"): BrowserBookmarkDocument {
	return {
		version: 1,
		source: { browser: "chrome", profile: "Default profile", fingerprint },
		importedAt: "2026-08-18T00:00:00.000Z",
		importedBookmarks: 1,
		skippedBookmarks: 0,
		roots: {
			bookmark_bar: {
				type: "folder",
				id: "folder-bar",
				name: "Bookmarks bar",
				children: [{ type: "url", id: "url-docs", name: "AO docs", url }],
			},
			other: { type: "folder", id: "folder-other", name: "Other bookmarks", children: [] },
			synced: { type: "folder", id: "folder-synced", name: "Mobile bookmarks", children: [] },
		},
	};
}

describe("AO browser bookmark storage", () => {
	it("writes one AO-owned document atomically and reloads it after restart", async () => {
		const stateDir = await mkdtemp(path.join(os.tmpdir(), "ao-browser-bookmarks-"));
		try {
			const storage = createBrowserBookmarkStorage({ stateDir });
			const document = documentFor("a".repeat(64));

			expect(await storage.write(document)).toMatchObject({ created: true, document });
			expect(await readdir(stateDir)).toEqual([AO_BROWSER_BOOKMARKS_FILE_NAME]);

			const restarted = createBrowserBookmarkStorage({ stateDir });
			expect(await restarted.read()).toEqual(document);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	it("is idempotent for the same source and refuses silent replacement", async () => {
		const stateDir = await mkdtemp(path.join(os.tmpdir(), "ao-browser-bookmarks-"));
		try {
			const storage = createBrowserBookmarkStorage({ stateDir });
			const first = documentFor("b".repeat(64));
			const sameSource = documentFor("b".repeat(64), "https://ao.example.test/changed");
			const differentSource = documentFor("c".repeat(64));

			await storage.write(first);
			expect(await storage.write(sameSource)).toMatchObject({ created: false, document: first });
			await expect(storage.write(differentSource)).rejects.toMatchObject({ code: "DESTINATION_NOT_EMPTY" });
			expect(await storage.read()).toEqual(first);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	it("supports controller rollback followed by a retry", async () => {
		const stateDir = await mkdtemp(path.join(os.tmpdir(), "ao-browser-bookmarks-"));
		try {
			const storage = createBrowserBookmarkStorage({ stateDir });
			const first = documentFor("d".repeat(64));
			const retry = documentFor("e".repeat(64));

			await storage.write(first);
			await storage.removeIfMatches(first);
			expect(await storage.read()).toBeNull();
			expect(await storage.write(retry)).toMatchObject({ created: true, document: retry });
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});
});
