import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserDownloadManager } from "./browser-download-manager";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
	const root = mkdtempSync(path.join(os.tmpdir(), "ao-browser-downloads-"));
	temporaryDirectories.push(root);
	const downloadsDirectory = path.join(root, "Downloads");
	const historyPath = path.join(root, "data", "browser-downloads.json");
	const notify = vi.fn();
	const openPath = vi.fn(async () => "");
	const showItemInFolder = vi.fn();
	const manager = createBrowserDownloadManager({
		downloadsDirectory,
		historyPath,
		shell: { openPath, showItemInFolder },
		notify,
		now: () => 42,
		createId: () => "download-1",
	});
	let willDownload: ((_event: unknown, item: unknown) => void) | undefined;
	const session = {
		on: vi.fn((event: string, listener: (_event: unknown, item: unknown) => void) => {
			if (event === "will-download") willDownload = listener;
		}),
	};
	manager.attach(session as never);
	return { downloadsDirectory, historyPath, manager, notify, openPath, session, showItemInFolder, start: (item: FakeDownloadItem) => willDownload?.({}, item as never) };
}

class FakeDownloadItem extends EventEmitter {
	receivedBytes = 0;
	totalBytes = 100;
	paused = false;
	setSavePath = vi.fn();
	pause = vi.fn(() => { this.paused = true; });
	resume = vi.fn(() => { this.paused = false; });
	cancel = vi.fn();
	getFilename = () => "report.txt";
	getReceivedBytes = () => this.receivedBytes;
	getTotalBytes = () => this.totalBytes;
	isPaused = () => this.paused;
}

describe("browser download manager", () => {
	it("tracks progress, supports controls, and reveals a completed system download", async () => {
		const test = setup();
		mkdirSync(test.downloadsDirectory, { recursive: true });
		writeFileSync(path.join(test.downloadsDirectory, "report.txt"), "existing");
		const item = new FakeDownloadItem();

		test.start(item);
		const savePath = path.join(test.downloadsDirectory, "report (1).txt");
		expect(item.setSavePath).toHaveBeenCalledWith(savePath);
		expect(test.manager.list().downloads[0]).toMatchObject({ id: "download-1", fileName: "report (1).txt", status: "progressing" });

		item.receivedBytes = 25;
		item.emit("updated", {}, "progressing");
		expect(test.manager.list().downloads[0]?.receivedBytes).toBe(25);
		await test.manager.action({ id: "download-1", action: "pause" });
		expect(item.pause).toHaveBeenCalledOnce();
		await test.manager.action({ id: "download-1", action: "resume" });
		expect(item.resume).toHaveBeenCalledOnce();

		item.receivedBytes = 100;
		item.emit("done", {}, "completed");
		writeFileSync(savePath, "downloaded");
		await test.manager.action({ id: "download-1", action: "show" });
		expect(test.showItemInFolder).toHaveBeenCalledWith(savePath);
		await test.manager.action({ id: "download-1", action: "open" });
		expect(test.openPath).toHaveBeenCalledWith(savePath);
		expect(JSON.parse(readFileSync(test.historyPath, "utf8"))[0]).toMatchObject({ status: "completed", savePath });

		test.manager.clear();
		expect(test.manager.list().downloads).toEqual([]);
	});

	it("attaches once per Electron session and restores unfinished history as interrupted", () => {
		const test = setup();
		test.manager.attach(test.session as never);
		expect(test.session.on).toHaveBeenCalledTimes(1);
		const item = new FakeDownloadItem();
		test.start(item);

		const restored = createBrowserDownloadManager({
			downloadsDirectory: test.downloadsDirectory,
			historyPath: test.historyPath,
			shell: { openPath: vi.fn(async () => ""), showItemInFolder: vi.fn() },
			notify: vi.fn(),
		});
		expect(restored.list().downloads[0]?.status).toBe("interrupted");
	});
});
